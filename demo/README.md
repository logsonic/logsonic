# LogSonic UI demo (for Kap screen-recordings)

`logsonic-demo.mjs` drives the real LogSonic web UI with Playwright — empty
state → import wizard → search — slowly and headed, so you can screen-record it
with [Kap](https://getkap.co) (or any recorder). Every step goes through the UI,
not the ingest API.

![LogSonic demo](demo.gif)

The GIF above (`demo.gif`) was produced from a Kap recording (`demo.webm`) with:

```bash
ffmpeg -y -i demo.webm -vf "fps=12,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/palette.png
ffmpeg -y -i demo.webm -i /tmp/palette.png \
  -lavfi "fps=12,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" demo.gif
```

## 1. Start the app (two terminals)

```bash
cd backend  && go run main.go -port 8080
cd frontend && PORT=8081 npm run dev
```

## 2. Record

Open Kap, drag its capture frame over the browser window area, and hit record.
Then run:

```bash
node demo/logsonic-demo.mjs
```

A Chromium window opens at 1440×900 (positioned near the top-left) and walks
through the flow. Stop Kap when the script prints `Demo flow complete.`

## What it does

1. Clears existing logs for a clean start.
2. Opens the LogSonic home page.
3. Opens the **Import** wizard.
4. Selects `sample-logs/linux-syslog.log` + `sample-logs/apache.log` (plain
   text, no JSON).
5. Lets the wizard **auto-detect** the grok pattern.
6. **Clicks the file** to expand its detail, then opens the **timestamp
   settings / correction** panel (the year-less syslog timestamps are resolved
   against the file's mtime).
7. Imports, then returns home.
8. Switches to **dark mode** (the Moon icon), holds for 3s, then reverts to light.
9. Searches `authentication failure` (matches the syslog logs).
10. Adds a **row-coloring rule** — highlights rows where `program` contains
    `sshd` (the SSH auth lines).
11. Searches `error` — the apache logs are dated **2005**, outside the default
    time window, so nothing shows. The demo then clicks **"Fit time range"** to
    snap the window to the indexed data and reveal the results.
12. Opens the **Filters** panel and toggles a source off and back on.

## Knobs (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `FILES` | linux-syslog + apache | Comma-separated log paths to import. |
| `FEATURE` | first `FILES` entry | Basename of the file whose detail panel is opened on camera (settings + timestamp correction). |
| `SEARCH1` / `SEARCH2` | `authentication failure` / `error` | The two closing search queries. `SEARCH2` is expected to land outside the time window so the "Fit time range" click has something to reveal. |
| `WINDOW` | fills main display | Window size `WIDTH,HEIGHT`, e.g. `2560,1400`. |
| `WINDOW_POS` | `0,0` | Window top-left in the multi-display space. Target a second screen by its origin — e.g. the 5K display above the main one is `-1723,-2160`. |
| `FULLSCREEN` | off | `FULLSCREEN=1` uses the whole screen with no browser chrome (max height). |
| `MAXIMIZE` | off | `MAXIMIZE=1` maximizes to the screen the window opens on. |
| `SLOWMO` | `350` | ms between actions. Raise it for a calmer recording. |
| `STEPDELAY` | `2200` | ms beat between import-wizard steps so each one is clearly visible. Raise for a slower walkthrough. |
| `STARTDELAY` | `10` | Seconds to wait once the UI is up (browser open on the home page) before the demo actions begin, so you can frame Kap and start recording. Set `0` to skip. |
| `CLEAR` | clears | Set `CLEAR=0` to keep existing logs. |
| `KEEP_OPEN` | closes | Set `KEEP_OPEN=1` to leave the browser open at the end. |
| `FRONTEND` / `BACKEND` | `:8081` / `:8080` | Override if you run on other ports. |

Example — a slower run that keeps the window open afterward:

```bash
SLOWMO=600 KEEP_OPEN=1 node demo/logsonic-demo.mjs
```

Example — record on the tall 5K display (above the main screen) using its full
height with no browser chrome:

```bash
WINDOW_POS=-1723,-2160 FULLSCREEN=1 node demo/logsonic-demo.mjs
```

Or a large windowed size on that screen instead of fullscreen:

```bash
WINDOW_POS=-1723,-2160 WINDOW=2560,2000 node demo/logsonic-demo.mjs
```

## Streaming demo

`streaming-demo.mjs` is a smoke/demo runner for live tailing. It starts the
backend and frontend dev servers if they are not already running, opens the UI,
waits for the live listener, generates structured synthetic logs, streams them
into `/api/v1/live/stdin`, and verifies that they are searchable.

```bash
node demo/streaming-demo.mjs
```

Useful variants:

```bash
ROWS=400 RATE=12 KEEP_OPEN=1 node demo/streaming-demo.mjs
MODE=file node demo/streaming-demo.mjs
```

| Var | Default | Notes |
|-----|---------|-------|
| `ROWS` | `240` | Number of synthetic rows to generate. |
| `RATE` | `8` | Rows per second. |
| `MODE` | `stdin` | Use `stdin` for `/live/stdin`, or `file` for server-side file tailing. |
| `KEEP_OPEN` | closes | Set `KEEP_OPEN=1` to leave the browser and auto-started servers running. |
| `CLEAR` | auto | Auto-clears demo-started storage; set `CLEAR=1` to clear an existing backend or `CLEAR=0` to keep all logs. |
| `FRONTEND` / `BACKEND` | `:8081` / `:8080` | Override when targeting already-running servers. |
| `HEADLESS` | headed | Set `HEADLESS=1` for an automated smoke run. |
