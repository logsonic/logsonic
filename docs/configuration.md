# Configuration

LogSonic can be configured with command-line flags or environment variables.

## Command-Line Flags

- `-host`: host address to bind to, default `localhost`
- `-port`: port to listen on, default `8080`
- `-storage`: path to storage directory for indices
- `-open`: open the web UI in your browser once the server starts
- `-browser`: same as `-open` for the CLI; does not launch Logsonic.app
- `-auto-port`: if the port is busy, bind the next free port instead of failing; enabled by default, pass `-auto-port=false` to fail instead
- `-retention-days N`: delete indexed logs older than N days; `0` keeps everything. This is the *default*: a value saved from the UI (or `PUT /api/v1/storage`) into `<storage>/config.json` takes precedence — see [Retention precedence](#retention-precedence)
- `-allowed-hosts`: comma-separated extra Host header values to accept, on top of `localhost`/`127.0.0.1`/`::1`; only consulted when `-host` is not loopback (see [Security model](#security-model) below)
- `-help`: show usage information

## Environment Variables

- `HOST`: host address to bind to
- `PORT`: port to listen on
- `STORAGE_PATH`: path to storage directory
- `LOGSONIC_OPEN_BROWSER`: open the web UI on start (`1`, `true`, `yes`, `on`)
- `LOGSONIC_BROWSER`: same as `LOGSONIC_OPEN_BROWSER` for the CLI; on **Logsonic.app**, skip the in-app window and open a browser
- `LOGSONIC_AUTO_PORT`: auto-select a free port if busy (`1`, `true`, `yes`, `on`)
- `RETENTION_DAYS`: delete indexed logs older than N days
- `LOGSONIC_ALLOWED_HOSTS`: same as `-allowed-hosts`

The **Logsonic.app** bundle shows the UI in an in-app window by default. Pass `--browser` (or `LOGSONIC_BROWSER=1`) to open the system browser instead. The CLI also auto-selects the first free port starting at `8080`, and does not open a browser unless you pass `-open` or `-browser`.

The app wrapper always binds its child server to `127.0.0.1`, even if `HOST` is set in the launch environment. LogSonic's local API is unauthenticated, so network listeners are an explicit CLI-only choice (`logsonic -host 0.0.0.0`).

## Security model

LogSonic's API has no login and no API key — that's deliberate for a local, single-user tool, but it means the loopback listener needs its own hardening rather than relying on "it's only reachable from this machine" as a promise. Two protections are in place:

**Host-header allow-list.** Every request's `Host` header is checked before it reaches any route, including `/mcp` and the SPA itself. This closes a real gap that CORS alone does not: CORS stops a script on `some-other-site.com` from reading a cross-origin response, but it does **not** stop [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding) — a page whose domain briefly resolves to `127.0.0.1` is loaded *same-origin* by the browser and can call the API directly. The allow-list closes that by rejecting any request whose `Host` header isn't one LogSonic actually expects, regardless of where the TCP connection came from.

- **Default (loopback) binds** — `logsonic`, `logsonic -open`, and the native app all bind `127.0.0.1` or `localhost` — accept only `Host: localhost`, `Host: 127.0.0.1`, and `Host: ::1` (with or without a port). Anything else gets **HTTP 421 Misdirected Request** with a JSON body (`code: "HOST_NOT_ALLOWED"`). This is on by default and needs no configuration.
- **Non-loopback binds** (`-host 0.0.0.0`, a specific LAN IP; this is also what the Docker image does — see below) can't use that fixed list, since a legitimate LAN browser sends `Host: myserver:8080` and a Docker port-mapped client sends whatever hostname it was given. So the check is **opt-in** there: pass `-allowed-hosts host1,host2` (or `LOGSONIC_ALLOWED_HOSTS=host1,host2`) to enable it for exactly those names, in addition to loopback. Without it, the check is skipped entirely and a single warning line is printed to stderr at startup — existing LAN and Docker deployments keep working with no behavior change.

```bash
# Docker's HOST=0.0.0.0 keeps working unchanged: the check stays off unless
# you opt in.
docker run -p 8080:8080 logsonic

# Opt in to hardening a LAN bind:
logsonic -host 0.0.0.0 -allowed-hosts myserver.local
```

**Content-Security-Policy.** The HTML page (not the JSON/SSE API responses) is served with a `Content-Security-Policy` header restricting scripts, styles, connections, and frames to the app's own origin. This makes the "no telemetry, no cloud, no network calls" promise enforced by the browser itself, not just true by inspection.

Mutating API requests (`POST`/`PUT`/`PATCH`) that carry a body must send `Content-Type: application/json` — a form-encoded body is rejected with `415 Unsupported Media Type`. Requests with no body (most `DELETE`s, pause/resume-style POSTs) are unaffected.

None of this requires a token today — the local API stays open to any client that presents an allowed `Host` header, matching LogSonic's local-first, single-user design. A per-launch authentication token is planned (see the roadmap) for the case of a genuinely multi-user machine.

## CLI Subcommands

- `logsonic mcp [--url http://localhost:8080]`: start the MCP stdio server for AI clients
- `logsonic tail -f /path/to/file [options]`: ask the running LogSonic server to follow a file it can read
- `cmd | logsonic tail - [options]`: stream lines from stdin into LogSonic

Tail options include `--url http://localhost:8080` or `LOGSONIC_URL`, `--source NAME`, `--pattern SAVED_PATTERN`, `--grok '...'`, and `--smart`.

## Examples

```bash
# Basic usage with defaults
logsonic

# Custom host and port
logsonic -host 0.0.0.0 -port 9000

# Custom storage path
logsonic -storage /var/logs/storage

# App-style: auto-select a free port and open the browser (no Logsonic.app window)
logsonic -open
logsonic -browser

# Cap on-disk index size
logsonic -retention-days 30

# Harden a LAN bind against untrusted Host headers
logsonic -host 0.0.0.0 -allowed-hosts myserver.local

# Environment variables
HOST=0.0.0.0 PORT=9000 STORAGE_PATH=/var/logs/storage logsonic
```

## Retention precedence

Retention can be set in three places. The first one that is set wins:

1. **`<storage>/config.json`** — `retention_days`, written by the Storage settings page or `PUT /api/v1/storage {"retention_days": N}`. `0` here means *keep everything* even if the flag says otherwise; `null` (or deleting the key) clears the override.
2. **`-retention-days N`** on the command line.
3. **`RETENTION_DAYS=N`** in the environment.

`GET /api/v1/storage` reports the value in effect and its source (`config`, `flag`, or `none`), plus the flag/env default the override falls back to. The server logs which source won at startup, e.g. `retention: 7 day(s) from config.json, overriding -retention-days 30`. The sweep runs at startup, once a day, and immediately after a `PUT`. `DELETE /api/v1/storage/days/{date}` removes one day regardless of retention.

`config.json` is shared with other server-side settings; keys this version doesn't know are preserved when retention is saved.
