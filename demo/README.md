# LogSonic UI demo (for Kap screen-recordings)

`combined-demo.mjs` drives the real LogSonic web UI with Playwright — empty
state → import wizard → search → Livestream pause/resume — slowly and headed,
so you can screen-record it with [Kap](https://getkap.co) (or any recorder).
Every visible step goes through the UI; the live rows are streamed through the
same live-tail API used by `logsonic tail`.

![LogSonic demo](demo.gif)

The GIF above (`demo.gif`) was produced from a Kap recording (`demo.mp4`) with
UI-oriented settings: a full-video palette and no dithering. That avoids the
speckled look that Bayer dithering creates on text and table rows.

```bash
ffmpeg -y -i demo.mp4 \
  -filter_complex "fps=12,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=full:reserve_transparent=0[p];[s1][p]paletteuse=dither=none" \
  -loop 0 demo.gif
```

## 1. Install dependencies

```bash
cd frontend
npm ci
cd ..
```

The combined demo starts local backend/frontend dev servers when they are not
already running.

## 2. Record

Open Kap, drag its capture frame over the browser window area, and hit record.
Then run:

```bash
node demo/combined-demo.mjs
```

A Chromium window opens at 1440×900 (positioned near the top-left) and walks
through the flow. Stop Kap when the script prints `Combined demo complete.`

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
8. Searches `authentication failure` (matches the syslog logs).
9. Starts a live stdin source.
10. Shows the live tile appearing only after the live source starts.
11. Clicks **Pause**, keeps streaming rows, then clicks **Resume**.
12. Verifies the streamed rows are searchable.

## Knobs (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `FILES` | linux-syslog + apache | Comma-separated log paths to import. |
| `FEATURE` | first `FILES` entry | Basename of the file whose detail panel is opened on camera (settings + timestamp correction). |
| `SEARCH` | `authentication failure` | Search query shown before the Livestream section. |
| `ROWS` | `180` | Number of synthetic live rows to stream. |
| `RATE` | `14` | Live rows per second. |
| `WINDOW` | fills main display | Window size `WIDTH,HEIGHT`, e.g. `2560,1400`. |
| `WINDOW_POS` | `0,0` | Window top-left in the multi-display space. Target a second screen by its origin — e.g. the 5K display above the main one is `-1723,-2160`. |
| `FULLSCREEN` | off | `FULLSCREEN=1` uses the whole screen with no browser chrome (max height). |
| `MAXIMIZE` | off | `MAXIMIZE=1` maximizes to the screen the window opens on. |
| `SLOWMO` | `180` | ms between browser actions. Raise it for a calmer recording. |
| `STEPDELAY` | `1400` | ms beat between visible steps. Raise for a slower walkthrough. |
| `STARTDELAY` | `4` | Seconds to wait once the UI is up before the demo actions begin. |
| `PAUSE_HOLD_MS` | `2500` | How long to hold the paused live feed before resuming. |
| `ENDDELAY` | `5000` | Final hold after the demo completes. |
| `CLEAR` | keeps | Set `CLEAR=1` to clear existing logs first. |
| `KEEP_OPEN` | closes | Set `KEEP_OPEN=1` to leave the browser open at the end. |
| `FRONTEND` / `BACKEND` | `:8081` / `:8080` | Override if you run on other ports. |
| `HEADLESS` | headed | Set `HEADLESS=1` for automated smoke runs. |

Example — a slower run that keeps the window open afterward:

```bash
SLOWMO=400 KEEP_OPEN=1 node demo/combined-demo.mjs
```

Example — record on the tall 5K display (above the main screen) using its full
height with no browser chrome:

```bash
WINDOW_POS=-1723,-2160 FULLSCREEN=1 node demo/combined-demo.mjs
```

Or a large windowed size on that screen instead of fullscreen:

```bash
WINDOW_POS=-1723,-2160 WINDOW=2560,2000 node demo/combined-demo.mjs
```

## Streaming demo

For a single recording that shows import/search and then the Livestream UI,
run the combined demo:

```bash
node demo/combined-demo.mjs
```

It starts local dev servers when needed, imports the sample logs through the
wizard, searches them, starts a live stdin stream, shows the live tile appearing
only after the source starts, clicks Pause/Resume, and verifies that the streamed
rows are searchable.

Useful variants:

```bash
ROWS=240 RATE=16 KEEP_OPEN=1 node demo/combined-demo.mjs
HEADLESS=1 STARTDELAY=0 STEPDELAY=100 ROWS=40 RATE=30 node demo/combined-demo.mjs
```

`streaming-demo.mjs` is a smoke/demo runner for live tailing. It starts the
backend and frontend dev servers if they are not already running, opens the UI,
generates structured synthetic logs, streams them into `/api/v1/live/stdin`,
waits for the live tile to appear, and verifies that the rows are searchable.

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
