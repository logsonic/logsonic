# LogSonic roadmap

> **The local log brain — for you and your agents.** Not a lightweight ELK, not a log viewer: the private, indexed, queryable memory of everything your systems say, readable by humans through a fast UI and by AI through MCP.

This is the public distillation of the maintainer's planning document. Items are grouped by horizon, not promised by date; order within a horizon is roughly the order of work. If you want to influence it, open an issue and reference the item.

## What "desktop-first" means here

Every planned item serves at least one of these. They are the bar the project is judged against.

| | Principle | In practice |
|---|-----------|-------------|
| D1 | **The file is already here** | Import by path, straight from disk — `.gz`, `.zst`, rotated sets, `.jsonl`. A multi-gigabyte dump is a normal Tuesday. |
| D2 | **Private by construction** | Zero network calls, proven by an automated test. A loopback server hardened against the attacks loopback servers actually face. |
| D3 | **Instant, then correct** | Cold launch to a usable UI in under two seconds; first rows of a dropped file within seconds; every search bounded. |
| D4 | **Keyboard-complete** | A whole investigation without the mouse: `⌘K` commands, `/` search, `j/k` rows, `Enter` to inspect, `⌘C` to copy. |
| D5 | **Native where it shows** | Titlebar, menus, dialogs, notifications, window memory — native. One web codebase underneath. |
| D6 | **Remembers everything, loses nothing** | Relaunch restores where you were. A corrupt index is reported, never silently skipped. |
| D7 | **A CLI citizen** | `logsonic open app.log`, `logsonic doctor`, `logsonic --version`. One verb away from any terminal. |
| D8 | **Explainable when it fails** | Every error names the file, line, pattern, or field and what to do next. |

## Now — v1.7

Trust, fields, and "the file is already here."

- **Self-hosted fonts** — the UI never contacts a font CDN; the platform's own font stack is used. *(shipped on `dev`)*
- **Loopback hardening** — Host-header allow-list against DNS rebinding, a Content-Security-Policy on the app, JSON-only mutating requests. Opt-in for LAN and Docker binds. *(phase 1 shipped on `dev`)*
- **Repo hygiene** — `--version`, a build identity on `/api/v1/info`, a query-encoding fix, accurate docs. *(shipped on `dev`)*
- **CI quality gate** — tests, lint, a Swift compile check, a packaging dry run, and an automated "zero network calls" check on every pull request.
- **Faceted fields sidebar** — every parsed field with its top values and counts; click to filter, alt-click to exclude.
- **Native path-based import** — the server reads files by path with gzip/zstd detection and rotated-file sets; drag-and-drop in the Mac app hands over a path instead of bytes, retiring the size cap.
- **Saved queries and history** — recall with ↑/↓, star to keep, saved in the workspace.
- **macOS: visible nativeness** — unified titlebar, follows system appearance, remembers its window.

## Now — v1.8

Habit, sources, the CLI citizen.

- **Sources catalog** — see every source with its origin, pattern, row count, and time span; delete or re-import one; manage retention from the UI.
- **Folder watch** — point LogSonic at a directory; new and changed files ingest automatically.
- **`logsonic open` and sample data** — open a log from any terminal; try the app with bundled sample data in seconds.
- **Diagnostics and `logsonic doctor`** — one command (or one button) that produces everything a bug report needs.
- **Command palette (⌘K)** — sources, saved queries, actions, and history in one surface.
- **Distribution parity** — winget and Scoop on Windows; deb, rpm, and AUR on Linux.

## Next — v2.x

Every log's local destination.

- **OpenTelemetry log ingest** — a zero-config local OTLP sink for development.
- **Log reader mode** — keyboard row navigation, a context view around any row, wrap toggle, a row inspector, copy as text/JSON/Markdown, CSV and Markdown export, session restore.
- **Storage engine hardening** — lazy index open, sort on any field without unbounded memory, index-format versioning, crash-safety tests.
- **Query-bar ergonomics** — AND-by-default as an explicit option, inline parse errors, field and value autocomplete. The query syntax itself does not change.
- **Container sources** — follow `docker logs` and `kubectl logs` as first-class sources.
- **Pattern clustering** — "3,000,000 lines → 42 patterns," with drill-down.
- **Watchers and notifications** — be told when a query matches during a live tail.
- **MCP depth** — aggregation and pattern tools, saved queries as resources, an investigation prompt.
- **Opt-in update check** — off by default, one anonymous request, the only network call the app can ever make.
- **Compare mode** — what appeared, disappeared, or changed frequency between two windows or sources.
- **Case files** — export an investigation as one bundle another LogSonic can open.

## Later — v3

Teams and sustainability.

- **Team edition** — a self-hosted shared instance with authentication, shared workspaces, and retention policies. Self-hosted, never "our cloud."
- **Metrics from logs** — pinned counters and rates derived from queries.
- **Trace correlation** — one click from a row to its whole trace across sources.
- **Plugin system** — community sources and parsers without forking.
- **Windows and Linux native shells** — the macOS shell pattern, ported.

## Deliberately out of scope

- A hosted cloud service.
- A new query language beyond the current shorthand.
- Mobile apps.
- A bundled local LLM — MCP already delegates intelligence to the user's own agent.
- Any network call other than the opt-in update check: no telemetry, no crash upload, no font CDN, no usage stats.
- Localization before v3.
