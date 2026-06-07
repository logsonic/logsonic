# Live Streaming And Tailing

Start LogSonic first, then leave the browser UI open. The UI switches to incoming rows as soon as a live source starts.

## Follow A Server-Side File

```bash
logsonic tail -f /var/log/app.log --source app
```

The path must be readable by the machine running the LogSonic server. This mode stays attached until you press `Ctrl+C`; on exit the CLI stops the live source.

## Stream From Stdin

```bash
tail -f /var/log/app.log | logsonic tail - --source app
```

Use a saved Grok pattern or inline pattern when the default whole-line parser is not enough:

```bash
logsonic tail -f /var/log/app.log \
  --source app \
  --grok '%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}' \
  --smart
```

Both modes send rows through the live-tail API, publish them to connected browsers, and index them so normal search still works. Point the CLI at another server with `--url http://host:port` or `LOGSONIC_URL=http://host:port`.

## Endless Python Generator

For a dependency-free live stream, use the Python helper. It emits structured synthetic events forever by default:

```bash
PATTERN="$(python3 demo/logsonic-event-generator.py --print-grok)"
python3 demo/logsonic-event-generator.py --rate 10 \
  | logsonic tail - --source synthetic --grok "$PATTERN" --smart
```

Press `Ctrl+C` to stop. For a finite smoke sample, add `--count 100`.

To exercise server-side file following, run the tail command in one terminal and the generator in another:

```bash
PATTERN="$(python3 demo/logsonic-event-generator.py --print-grok)"
touch /tmp/logsonic-live.log
logsonic tail -f /tmp/logsonic-live.log --source synthetic --grok "$PATTERN" --smart
```

```bash
python3 demo/logsonic-event-generator.py --rate 10 --output /tmp/logsonic-live.log
```

## Streaming Demo

The combined demo shows import/search and Livestream in one UI recording: it imports sample logs, searches them, starts a live stdin stream, clicks Pause/Resume, and verifies that streamed rows are searchable.

```bash
node demo/combined-demo.mjs
```

For a smaller live-tail smoke run, use the streaming demo. It generates structured synthetic logs, streams them through the live API, and checks that they are searchable. Install frontend dependencies once so Playwright is available, then run it from the repo root:

```bash
cd frontend
npm ci
cd ..
node demo/streaming-demo.mjs
```

Useful variants:

```bash
# Larger visible demo; keeps the browser and auto-started dev servers open
ROWS=400 RATE=12 KEEP_OPEN=1 node demo/streaming-demo.mjs

# Exercise server-side file tailing instead of stdin streaming
MODE=file node demo/streaming-demo.mjs

# Headless smoke run for automation
HEADLESS=1 node demo/streaming-demo.mjs
```

By default the generator starts backend/frontend dev servers if they are not already running, targets `http://localhost:8080` and `http://localhost:8081`, clears only demo-started storage, streams 240 rows at 8 rows per second, and tags rows with `demo:streaming`. When targeting an existing backend, logs are kept unless you set `CLEAR=1`.
