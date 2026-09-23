# LogSonic

> **Drop a log file or livestream one. Search it in seconds. Keep it fully offline. Let your AI agent query it.**

[![CI](https://github.com/logsonic/logsonic/actions/workflows/ci.yml/badge.svg)](https://github.com/logsonic/logsonic/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/logsonic/logsonic?label=release)](https://github.com/logsonic/logsonic/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/logsonic/logsonic?style=social)](https://github.com/logsonic/logsonic/stargazers)

LogSonic is a local-first log analytics app for Windows, Mac, and Linux. One self-contained binary serves a fast browser UI, auto-detects log formats, indexes everything for full-text search, and ships an MCP server so Claude, Cursor, Windsurf, or any MCP client can query your local logs. No telemetry. No cloud. No network calls.

<img src="demo/demo.gif" alt="LogSonic demo: import logs, search them, then livestream rows with pause and resume" width="1000" />

## New in v1.7.0

- **Redesigned import flow.** A single-surface import page replaces the old wizard, with async ingest jobs, live SSE progress, cancellation, and path-based preview for large files.
- **Sources catalog.** Manage imported sources from a Storage settings page — rename, re-import (without losing history or aliases), or delete a source, with per-day retention overrides.
- **Watched folders.** Point LogSonic at a folder and it ingests new files automatically, with a settings page and status-bar indicator.
- **Saved queries and query history**, plus a Fields panel for click-to-filter/exclude facets.
- **`logsonic open`** launches with pattern auto-detection and a bundled sample import for a zero-config first run.
- **Hardening and fixes.** Tighter CSP and Host-header allow-listing, JSON-only mutating routes, fixed double-decoding of search queries (`%` in queries), corrected sort order for rows sharing a timestamp, and a fix for facet scans hanging on a stuck cursor.

## Livestream

Stream logs into LogSonic while the browser is open. `logsonic tail` can follow a server-side file or read stdin, publish rows to the UI in real time, keep indexing in the background, and let you pause/resume the browser feed without stopping ingestion.

```bash
tail -f /var/log/app.log | logsonic tail - --source app
logsonic tail -f /var/log/app.log --source app
```

Rows are searchable immediately, including rows skipped while the browser feed was paused. See [Live Streaming](docs/live-streaming.md) or run the combined import + Livestream demo:

```bash
node demo/combined-demo.mjs
```

## Installation

Install on macOS with Homebrew:

```bash
brew tap logsonic/logsonic
brew install logsonic
open -a Logsonic
```

Homebrew installs the signed and notarized native app into `/Applications` and also adds the `logsonic` CLI to your path. After installation, you can launch the app from Applications, Spotlight, Launchpad, or Finder. Use `logsonic -open` when you specifically want the browser-based CLI experience.

Upgrade an existing installation with:

```bash
brew update
brew upgrade logsonic
```

Or download a pre-built binary from [GitHub Releases](https://github.com/logsonic/logsonic/releases), then open the URL printed by the server, usually:

```text
http://localhost:8080
```

For Linux, Windows, Docker, source builds, storage locations, and the macOS app behavior, see [Installation](docs/installation.md).

## Who It's For

- Engineers who cannot send logs to cloud tools.
- AI-native developers who want local logs available to MCP clients.
- Backend and SRE teams debugging large log dumps without standing up ELK.

## Why LogSonic

| | **LogSonic** | lnav | Logdy | GoAccess | Datadog/ELK |
|---|:---:|:---:|:---:|:---:|:---:|
| Fully offline / local-first | yes | yes | yes | yes | no |
| Browser GUI | yes | terminal | yes | HTML report | yes |
| Auto-detect log formats | yes | partial | no | web logs only | yes |
| AI agent access (MCP) | yes | no | no | no | partial |
| Indexed full-text search | yes | yes | no | no | yes |
| Single binary, no deps | yes | yes | yes | yes | no |
| Live tail / streaming | yes | yes | yes | yes | yes |

## Features

- Native macOS app with an embedded UI, automatic port selection, browser fallback, server logs, and graceful shutdown.
- Format detection with [log2grok](https://github.com/logsonic/log2grok), including custom saved Grok patterns.
- Multi-file import with per-file format confirmation.
- Smart timestamp resolution for logs with missing years, timezones, or dates.
- Bleve-backed full-text search with field shorthand, regex, exclusions, boolean operators, bounded pagination, and responsive rendering for large result sets.
- Live tailing from stdin or server-side files.
- MCP server for AI clients.
- Saved local workspaces for recurring investigations.
- Color rules, event histogram, source filters, and dark/light themes.
- Local file-based storage with retention controls.
- `logsonic open app.log` from any terminal imports a file into the running app (starting it if needed) and prints the link to it.

## Documentation

- [Installation](docs/installation.md): Homebrew, app bundle, binaries, Docker, source builds, and storage paths.
- [Configuration](docs/configuration.md): command flags, environment variables, CLI subcommands, and examples.
- [Getting Started](docs/getting-started.md): importing logs, searching, and MCP setup links.
- [Live Streaming](docs/live-streaming.md): `logsonic tail`, stdin streaming, server-side file following, and demos.
- [Timestamp Resolution](docs/timestamp-resolution.md): how LogSonic derives real timestamps and when to override.
- [Development](docs/development.md): local backend/frontend setup, tests, E2E, and Swagger generation.
- [Architecture](docs/System_Architecture.md): backend, frontend, storage, ingest, search, and MCP architecture.
- [Roadmap](ROADMAP.md): the desktop-first principles, what is planned for the next releases, and what is deliberately out of scope.
- [MCP Setup](mcp/README.md): configure Claude Desktop, Cursor, Windsurf, or another MCP client.
- [Agent Playbook](mcp/SKILLS.md): query patterns and workflow guidance for AI clients.

## FAQ

**How does LogSonic handle large log files?**

It indexes logs with Bleve and stores local file-based indices for fast search over large datasets.

**Can I use custom log formats?**

Yes. Paste a Grok pattern during import or save custom patterns for reuse.

**Is my data sent to any servers?**

No. LogSonic runs locally and keeps data on your machine.

## Support

For issues, feature requests, or questions, open an issue on the [GitHub repository](https://github.com/logsonic/logsonic/issues).

## License

LogSonic is released under the [MIT License](LICENSE).
