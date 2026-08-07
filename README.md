# whoop-dash

Personal WHOOP dashboard for your Mac / Mac mini, with stress alerts and workout
nudges as native macOS notifications. Zero npm dependencies — just Node 18+.

## What it does

- Dashboard at `http://localhost:8787` — today's recovery (green/yellow/red zone),
  strain, HRV, resting HR, calories, last night's sleep, plus 14-day charts.
  Light/dark mode follows your system setting.
- Polls the official WHOOP API every 15 minutes.
- **Stress alerts** (macOS notifications, once per day each, quiet hours 10pm–7am):
  - Recovery below 33% (red zone)
  - Day strain ≥ 15 before 3pm
  - Resting HR ≥ 8% above your 14-day baseline
  - HRV ≥ 25% below your 14-day baseline
- **Workout nudges**: at 4pm and 7pm, if no workout is logged and strain is still
  low, it pings you — "How about a run / tennis / gym?"

All thresholds and times are configurable in `.env`.

## Setup (one time, ~5 minutes)

### 1. Create a WHOOP app

1. Go to https://developer-dashboard.whoop.com and log in with your WHOOP account.
2. Create an App. Name it anything (e.g. "jerry-dash").
3. Scopes: select `read:profile`, `read:recovery`, `read:cycles`, `read:sleep`,
   `read:workout`, `read:body_measurement`, and `offline` (offline is what gets
   you a refresh token so you never have to re-login).
4. Redirect URI: add exactly `http://localhost:8787/callback`
5. Copy the **Client ID** and **Client Secret**.

### 2. Configure and run

```bash
cd whoop-dash
cp .env.example .env
# edit .env: paste in WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET
npm start
```

Open http://localhost:8787 and click **Connect WHOOP** — you'll log in on
WHOOP's site once, then it redirects back and starts pulling data.

Click **Test alert** on the dashboard to confirm macOS notifications work.
(If nothing appears: System Settings → Notifications → allow notifications
from Script Editor / osascript.)

### 3. Run it 24/7 on the Mac mini (optional)

Edit `com.jerry.whoopdash.plist`: replace `/PATH/TO/whoop-dash` with the real
folder path (run `pwd` inside the folder), and check the `node` path matches
`which node`. Then:

```bash
cp com.jerry.whoopdash.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jerry.whoopdash.plist
```

It now starts on login and restarts if it crashes. Logs go to
`whoop-dash.log` in the project folder.

To stop: `launchctl unload ~/Library/LaunchAgents/com.jerry.whoopdash.plist`

## Notes

- Tokens live in `tokens.json` (chmod 600), data cache in `data.json`,
  alert history in `alert-state.json` — all local, nothing leaves your machine
  except calls to WHOOP's API.
- Data freshness = whenever your WHOOP app last synced with the band. Alerts
  are near-real-time at best (15-min polling), not instant.
- WHOOP's public API doesn't expose the in-app "Stress Monitor" score, so
  "stress" here = low recovery / suppressed HRV / elevated RHR / high strain.
- The API terms allow personal apps like this; just don't resell the data or
  redistribute API access.

## Tinkering ideas

- Change `NUDGE_TIMES` / `NUDGE_ACTIVITIES` in `.env`.
- Add webhook support (WHOOP can push `recovery.updated` events) to make
  alerts faster than polling.
- Point Claude at this folder and vibe-code new panels — `/api/summary`
  returns everything the UI uses as clean JSON.
