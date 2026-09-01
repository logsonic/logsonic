# Installation

## Homebrew (macOS)

The easiest way to install LogSonic on macOS. It installs the signed + notarized **Logsonic.app** into `/Applications` and symlinks the `logsonic` CLI into your Homebrew prefix:

```bash
brew tap logsonic/logsonic
brew install logsonic
logsonic
```

This gives you both the **Logsonic.app** launcher and the `logsonic` CLI.

**Upgrading:**

```bash
brew update && brew upgrade logsonic
```

If `brew upgrade` reports a checksum error or will not move off the installed version, refresh the tap:

```bash
brew untap logsonic/logsonic
brew tap logsonic/logsonic
brew install logsonic
```

Linux users should use the pre-built binary, Docker, or build from source.

## The macOS App

Whether installed via Homebrew or from the release `.zip`, **Logsonic.app** lives in `/Applications`.

1. Open it from Applications, Spotlight, Launchpad, or Finder.
2. The app picks the first free port starting at 8080 and loads the UI in its own window.
3. Use **View → Server Log** for the Go process output, **View → Open in Browser** to open the same UI in a browser, and **Quit** (or close the window) to stop the server.

Closing the app window stops the server. Press `Cmd+Q` or close the window to shut down gracefully.

The app stores indexed data under `~/Library/Application Support/Logsonic`. The `Logsonic.app` launcher always auto-selects a port and shows the UI in-app. To use a browser instead:

```bash
open -a Logsonic --args --browser
# or
LOGSONIC_BROWSER=1 /Applications/Logsonic.app/Contents/MacOS/LogsonicApp
```

To skip the app window entirely, run the CLI: `logsonic -open` (or `logsonic -browser`). It serves on the first free port starting at `http://localhost:8080`.

## Pre-Built Binary

Grab the latest build for your platform from the [GitHub releases page](https://github.com/logsonic/logsonic/releases).

**macOS:** download `logsonic_<version>_macos.zip`, unzip it, and drag **Logsonic.app** to Applications.

**Linux:**

```bash
tar -xzf logsonic_<version>_linux_<arch>.tar.gz
chmod +x logsonic
./logsonic
```

**Windows:** download the `.zip`, extract it, and run `logsonic.exe`.

Then open the URL printed by the server. It starts at `http://localhost:8080` and automatically uses the next free port if `8080` is unavailable.

Looking for sample logs? [LogHub](https://github.com/logpai/loghub/) has useful examples, including this [Apache log](https://github.com/logpai/loghub/blob/master/Apache/Apache_2k.log).

## Data And Storage

LogSonic indexes ingested logs into a per-user data directory. Override it with `-storage <dir>` or `STORAGE_PATH`.

| OS | Default location |
|---|---|
| macOS | `~/Library/Application Support/Logsonic` |
| Linux | `$XDG_DATA_HOME/logsonic` or `~/.local/share/logsonic` |
| Windows | `%APPDATA%\Logsonic` |

To keep storage bounded, run with `-retention-days N` or `RETENTION_DAYS=N`:

```bash
logsonic -retention-days 30
```

Removing the app does not delete indexed data. To purge it, run `brew uninstall --zap logsonic` or delete the data directory manually.

## Build From Source

### Prerequisites

- Go 1.26.6 or later
- Node.js 20 or later
- npm

### Steps

```bash
git clone https://github.com/logsonic/logsonic.git
cd logsonic
```

Build the frontend:

```bash
cd frontend
npm ci
npm run build
npm run build:copy
cd ..
```

Build the backend:

```bash
cd backend
go mod download
go build -o logsonic .
```

Run:

```bash
./logsonic
```

## Docker Image

```bash
docker buildx build -t logsonic .
docker run -p 8080:8080 -v /path/to/logs:/data logsonic
```

The image sets `HOST=0.0.0.0` so the server accepts connections from outside the container. LogSonic's [Host-header allow-list](configuration.md#security-model) is skipped by default on any non-loopback bind, including this one, so the container works unchanged: a request with `Host: localhost:8080` from the host machine (or whatever hostname you access the mapped port through) is accepted. Pass `-allowed-hosts` in the container's command if you want that check enforced.
