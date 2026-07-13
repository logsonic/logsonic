# LogSonic

> **Drop a log file or livestream one. Search it in seconds. Keep it fully offline. Let your AI agent query it.**

[![Release](https://img.shields.io/github/v/release/logsonic/logsonic?label=release)](https://github.com/logsonic/logsonic/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/logsonic/logsonic?style=social)](https://github.com/logsonic/logsonic/stargazers)

LogSonic is a local-first log analytics app for Windows, Mac, and Linux. One self-contained binary serves a fast browser UI, auto-detects log formats, indexes everything for full-text search, and ships an MCP server so Claude, Cursor, Windsurf, or any MCP client can query your local logs. No telemetry. No cloud. No network calls.

<img src="demo/demo.gif" alt="LogSonic demo: import logs, search them, then livestream rows with pause and resume" width="1000" />

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
logsonic
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

- Format detection with [log2grok](https://github.com/logsonic/log2grok), including custom saved Grok patterns.
- Multi-file import with per-file format confirmation.
- Smart timestamp resolution for logs with missing years, timezones, or dates.
- Bleve-backed full-text search with field shorthand, regex, exclusions, and boolean operators.
- Live tailing from stdin or server-side files.
- MCP server for AI clients.
- Saved local workspaces for recurring investigations.
- Color rules, event histogram, source filters, and dark/light themes.
- Local file-based storage with retention controls.

## Documentation

- [Installation](docs/installation.md): Homebrew, app bundle, binaries, Docker, source builds, and storage paths.
- [Configuration](docs/configuration.md): command flags, environment variables, CLI subcommands, and examples.
- [Getting Started](docs/getting-started.md): importing logs, searching, and MCP setup links.
- [Live Streaming](docs/live-streaming.md): `logsonic tail`, stdin streaming, server-side file following, and demos.
- [Timestamp Resolution](docs/timestamp-resolution.md): how LogSonic derives real timestamps and when to override.
- [Development](docs/development.md): local backend/frontend setup, tests, E2E, and Swagger generation.
- [Architecture](docs/Architecture.md): backend, frontend, storage, and MCP architecture.
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
