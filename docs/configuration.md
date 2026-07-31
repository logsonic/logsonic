# Configuration

LogSonic can be configured with command-line flags or environment variables.

## Command-Line Flags

- `-host`: host address to bind to, default `localhost`
- `-port`: port to listen on, default `8080`
- `-storage`: path to storage directory for indices
- `-open`: open the web UI in your browser once the server starts
- `-auto-port`: if the port is busy, bind the next free port instead of failing; enabled by default, pass `-auto-port=false` to fail instead
- `-retention-days N`: delete indexed logs older than N days; `0` keeps everything
- `-help`: show usage information

## Environment Variables

- `HOST`: host address to bind to
- `PORT`: port to listen on
- `STORAGE_PATH`: path to storage directory
- `LOGSONIC_OPEN_BROWSER`: open the web UI on start (`1`, `true`, `yes`, `on`)
- `LOGSONIC_AUTO_PORT`: auto-select a free port if busy (`1`, `true`, `yes`, `on`)
- `RETENTION_DAYS`: delete indexed logs older than N days

The **Logsonic.app** bundle sets `-open` and auto-port automatically. The CLI also auto-selects the first free port starting at `8080`, but it does not open a browser unless you pass `-open`.

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

# App-style: auto-select a free port and open the browser
logsonic -open

# Cap on-disk index size
logsonic -retention-days 30

# Environment variables
HOST=0.0.0.0 PORT=9000 STORAGE_PATH=/var/logs/storage logsonic
```
