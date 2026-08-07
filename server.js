#!/usr/bin/env node
/**
 * whoop-dash — personal WHOOP dashboard + stress alerts + workout nudges.
 * Zero npm dependencies. Node 18+.
 *
 *   1. cp .env.example .env  (fill in client id/secret from developer-dashboard.whoop.com)
 *   2. npm start
 *   3. open http://localhost:8787  → click "Connect WHOOP"
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ---------------------------------------------------------------- config ----

function loadEnv(file) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
    }
  }
  return env;
}

const ROOT = __dirname;
const env = { ...loadEnv(path.join(ROOT, ".env")), ...process.env };

const CFG = {
  clientId: env.WHOOP_CLIENT_ID || "",
  clientSecret: env.WHOOP_CLIENT_SECRET || "",
  redirectUri: env.REDIRECT_URI || "http://localhost:8787/callback",
  port: parseInt(env.PORT || "8787", 10),
  pollMinutes: parseInt(env.POLL_MINUTES || "15", 10),
  recoveryBelow: parseFloat(env.ALERT_RECOVERY_BELOW || "33"),
  strainAbove: parseFloat(env.ALERT_STRAIN_ABOVE || "15"),
  strainCutoffHour: parseInt(env.ALERT_STRAIN_CUTOFF_HOUR || "15", 10),
  rhrFactor: parseFloat(env.ALERT_RHR_FACTOR || "1.08"),
  hrvFactor: parseFloat(env.ALERT_HRV_FACTOR || "0.75"),
  nudgeTimes: (env.NUDGE_TIMES || "16:00,19:00").split(",").map(s => s.trim()),
  nudgeStrainBelow: parseFloat(env.NUDGE_STRAIN_BELOW || "10"),
  nudgeActivities: (env.NUDGE_ACTIVITIES || "run,tennis,gym").split(",").map(s => s.trim()),
  quietStart: parseInt(env.QUIET_START || "22", 10),
  quietEnd: parseInt(env.QUIET_END || "7", 10),
};

const TOKENS_FILE = path.join(ROOT, "tokens.json");
const DATA_FILE = path.join(ROOT, "data.json");
const STATE_FILE = path.join(ROOT, "alert-state.json");

const API = "https://api.prod.whoop.com/developer";
const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const SCOPES = "offline read:profile read:recovery read:cycles read:sleep read:workout read:body_measurement";

// ---------------------------------------------------------------- tokens ----

let tokens = null;
try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch { /* not connected yet */ }

function saveTokens(t) {
  tokens = t;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  const t = await res.json();
  t.obtained_at = Date.now();
  saveTokens(t);
  return t;
}

async function ensureAccessToken() {
  if (!tokens) throw new Error("not_connected");
  const age = (Date.now() - (tokens.obtained_at || 0)) / 1000;
  if (age > (tokens.expires_in || 3600) - 120) {
    await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      scope: "offline",
    });
  }
  return tokens.access_token;
}

// ------------------------------------------------------------- api client ----

async function apiGet(pathname, params = {}) {
  const token = await ensureAccessToken();
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get("retry-after") || "30", 10);
    console.warn(`[whoop] rate limited, waiting ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return apiGet(pathname, params);
  }
  if (!res.ok) throw new Error(`GET ${pathname} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiGetAll(pathname, start) {
  const records = [];
  let nextToken;
  do {
    const page = await apiGet(pathname, { limit: 25, start, nextToken });
    records.push(...(page.records || []));
    nextToken = page.next_token;
  } while (nextToken);
  return records;
}

// ------------------------------------------------------------------ store ----

let store = { updated: null, profile: null, cycles: [], recoveries: [], sleeps: [], workouts: [] };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* first run */ }

let alertState = { sent: {}, log: [] }; // sent: { "YYYY-MM-DD:key": true }
try { alertState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
function saveAlertState() { fs.writeFileSync(STATE_FILE, JSON.stringify(alertState, null, 2)); }

async function refreshData() {
  const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [profile, cycles, recoveries, sleeps, workouts] = await Promise.all([
    apiGet("/v2/user/profile/basic"),
    apiGetAll("/v2/cycle", start),
    apiGetAll("/v2/recovery", start),
    apiGetAll("/v2/activity/sleep", start),
    apiGetAll("/v2/activity/workout", start),
  ]);
  store = { updated: new Date().toISOString(), profile, cycles, recoveries, sleeps, workouts };
  fs.writeFileSync(DATA_FILE, JSON.stringify(store), { mode: 0o600 });
  console.log(`[whoop] refreshed ${new Date().toLocaleTimeString()} — ${cycles.length} cycles, ${recoveries.length} recoveries, ${sleeps.length} sleeps, ${workouts.length} workouts`);
}

// ---------------------------------------------------------------- derived ----

function localDayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentCycle() {
  // The in-progress cycle has no `end`.
  return store.cycles.find(c => !c.end) || store.cycles[0] || null;
}

function recoveryForCycle(cycleId) {
  return store.recoveries.find(r => r.cycle_id === cycleId) || null;
}

function baseline(values) {
  const v = values.filter(x => typeof x === "number" && !Number.isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function summary() {
  const cyc = currentCycle();
  const rec = cyc ? recoveryForCycle(cyc.id) : null;
  const lastSleep = store.sleeps.find(s => !s.nap) || store.sleeps[0] || null;

  const last14 = store.recoveries.slice(0, 14).map(r => r.score || {});
  const rhrBase = baseline(last14.map(s => s.resting_heart_rate));
  const hrvBase = baseline(last14.map(s => s.hrv_rmssd_milli));

  const todayKey = localDayKey();
  const workoutsToday = store.workouts.filter(w => localDayKey(new Date(w.start)) === todayKey);

  return {
    updated: store.updated,
    profile: store.profile,
    today: {
      recovery: rec?.score?.recovery_score ?? null,
      rhr: rec?.score?.resting_heart_rate ?? null,
      hrv: rec?.score?.hrv_rmssd_milli ?? null,
      spo2: rec?.score?.spo2_percentage ?? null,
      skinTempC: rec?.score?.skin_temp_celsius ?? null,
      strain: cyc?.score?.strain ?? null,
      avgHr: cyc?.score?.average_heart_rate ?? null,
      calories: cyc?.score?.kilojoule != null ? Math.round(cyc.score.kilojoule / 4.184) : null,
      sleepPerformance: lastSleep?.score?.sleep_performance_percentage ?? null,
      sleepHours: sleepHours(lastSleep),
      workoutsToday: workoutsToday.map(w => ({ sport: w.sport_name || w.sport_id, strain: w.score?.strain ?? null, start: w.start })),
    },
    baselines: { rhr: rhrBase, hrv: hrvBase },
    history: {
      recoveries: store.recoveries.map(r => ({ date: r.created_at, cycle_id: r.cycle_id, score: r.score?.recovery_score, rhr: r.score?.resting_heart_rate, hrv: r.score?.hrv_rmssd_milli })).reverse(),
      cycles: store.cycles.filter(c => c.score).map(c => ({ date: c.start, strain: c.score?.strain })).reverse(),
      sleeps: store.sleeps.filter(s => !s.nap).map(s => ({ date: s.start, hours: sleepHours(s), performance: s.score?.sleep_performance_percentage })).reverse(),
      workouts: store.workouts.map(w => ({ date: w.start, sport: w.sport_name || w.sport_id, strain: w.score?.strain })).reverse(),
    },
    alerts: alertState.log.slice(-20).reverse(),
    connected: !!tokens,
  };
}

function sleepHours(s) {
  if (!s) return null;
  const st = s.score?.stage_summary;
  if (st) {
    const ms = (st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0);
    if (ms > 0) return +(ms / 3600000).toFixed(1);
  }
  if (s.start && s.end) return +((new Date(s.end) - new Date(s.start)) / 3600000).toFixed(1);
  return null;
}

// ----------------------------------------------------------------- alerts ----

function inQuietHours(d = new Date()) {
  const h = d.getHours();
  if (CFG.quietStart > CFG.quietEnd) return h >= CFG.quietStart || h < CFG.quietEnd;
  return h >= CFG.quietStart && h < CFG.quietEnd;
}

function notify(title, message) {
  const entry = { at: new Date().toISOString(), title, message };
  alertState.log.push(entry);
  if (alertState.log.length > 200) alertState.log = alertState.log.slice(-200);
  saveAlertState();
  console.log(`[alert] ${title}: ${message}`);
  if (process.platform === "darwin") {
    const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], err => {
      if (err) console.warn("[alert] osascript failed:", err.message);
    });
  }
}

function onceToday(key, fn) {
  const k = `${localDayKey()}:${key}`;
  if (alertState.sent[k]) return;
  alertState.sent[k] = true;
  // prune old keys
  for (const old of Object.keys(alertState.sent)) if (!old.startsWith(localDayKey())) delete alertState.sent[old];
  saveAlertState();
  fn();
}

let nudgeIdx = 0;

function checkAlerts() {
  if (inQuietHours()) return;
  const s = summary();
  const t = s.today;
  const now = new Date();

  // 1. Low recovery (red zone)
  if (t.recovery != null && t.recovery < CFG.recoveryBelow) {
    onceToday("low-recovery", () =>
      notify("WHOOP: low recovery", `Recovery ${t.recovery}% — your body is under stress. Take it easy today.`));
  }
  // 2. High strain early in the day
  if (t.strain != null && t.strain >= CFG.strainAbove && now.getHours() < CFG.strainCutoffHour) {
    onceToday("high-strain-early", () =>
      notify("WHOOP: high strain", `Day strain already ${t.strain.toFixed(1)} before ${CFG.strainCutoffHour}:00 — pace yourself.`));
  }
  // 3. Elevated resting HR vs 14-day baseline
  if (t.rhr != null && s.baselines.rhr && t.rhr >= s.baselines.rhr * CFG.rhrFactor) {
    onceToday("elevated-rhr", () =>
      notify("WHOOP: elevated resting HR", `RHR ${t.rhr} bpm vs ~${Math.round(s.baselines.rhr)} baseline — possible stress, illness, or poor recovery.`));
  }
  // 4. Suppressed HRV vs 14-day baseline
  if (t.hrv != null && s.baselines.hrv && t.hrv <= s.baselines.hrv * CFG.hrvFactor) {
    onceToday("low-hrv", () =>
      notify("WHOOP: low HRV", `HRV ${Math.round(t.hrv)} ms vs ~${Math.round(s.baselines.hrv)} baseline — high physiological stress.`));
  }
  // 5. Workout nudges at configured times
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  for (const nt of CFG.nudgeTimes) {
    // fire within the poll window after the nudge time
    const [nh, nm] = nt.split(":").map(Number);
    const nudgeMoment = new Date(now); nudgeMoment.setHours(nh, nm, 0, 0);
    const diffMin = (now - nudgeMoment) / 60000;
    if (diffMin >= 0 && diffMin < CFG.pollMinutes + 1) {
      const noWorkout = t.workoutsToday.length === 0;
      const lowStrain = t.strain == null || t.strain < CFG.nudgeStrainBelow;
      if (noWorkout && lowStrain) {
        onceToday(`nudge-${nt}`, () => {
          const activity = CFG.nudgeActivities[nudgeIdx++ % CFG.nudgeActivities.length];
          notify("WHOOP: time to move", `No workout logged today and strain is only ${t.strain?.toFixed(1) ?? "—"}. How about a ${activity}?`);
        });
      }
    }
  }
}

// ----------------------------------------------------------------- poller ----

async function pollOnce() {
  if (!tokens) return;
  try {
    await refreshData();
    checkAlerts();
  } catch (e) {
    console.error("[poll] error:", e.message);
  }
}

setInterval(pollOnce, CFG.pollMinutes * 60 * 1000);
// also check nudge times more often than the poll (uses cached data)
setInterval(() => { try { if (tokens) checkAlerts(); } catch (e) { console.error(e.message); } }, 60 * 1000);

// ----------------------------------------------------------------- server ----

let oauthState = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CFG.port}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(ROOT, "public", "index.html")));
    } else if (url.pathname === "/auth") {
      if (!CFG.clientId || !CFG.clientSecret) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET in .env — see README.");
      }
      oauthState = crypto.randomBytes(16).toString("hex");
      const a = new URL(AUTH_URL);
      a.searchParams.set("client_id", CFG.clientId);
      a.searchParams.set("redirect_uri", CFG.redirectUri);
      a.searchParams.set("response_type", "code");
      a.searchParams.set("scope", SCOPES);
      a.searchParams.set("state", oauthState);
      res.writeHead(302, { Location: a.toString() });
      res.end();
    } else if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== oauthState) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("OAuth error: bad state or missing code. Try /auth again.");
      }
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: CFG.clientId,
        client_secret: CFG.clientSecret,
        redirect_uri: CFG.redirectUri,
      });
      pollOnce();
      res.writeHead(302, { Location: "/" });
      res.end();
    } else if (url.pathname === "/api/summary") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary()));
    } else if (url.pathname === "/api/refresh") {
      await pollOnce();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, updated: store.updated }));
    } else if (url.pathname === "/api/test-alert") {
      notify("WHOOP dashboard", "Test notification — alerts are working.");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404); res.end("not found");
    }
  } catch (e) {
    console.error("[http]", e.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("error: " + e.message);
  }
});

server.listen(CFG.port, () => {
  console.log(`whoop-dash → http://localhost:${CFG.port}`);
  if (!tokens) console.log(`Not connected yet — open the dashboard and click "Connect WHOOP".`);
  else pollOnce();
});
