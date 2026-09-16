# Getting Started

## Import Logs

1. Start LogSonic and open `http://localhost:8080`.
2. Click **Import** in the left rail.
3. Drop one or many `.log`, `.txt`, or `.json` files into the file picker. In the macOS app, you can also drop a file onto the Dock icon or use Finder's "Open With" — the app hands the server the file's path, and the server reads it from disk (gzip and zstd are detected automatically), so there's no size limit and no browser round-trip.
4. LogSonic auto-detects the format for each file with [log2grok](https://github.com/logsonic/log2grok). If detection succeeds, the wizard shows a **Pattern found** badge with a coverage score. If not, paste a custom Grok pattern and test it inline against a sample.
5. Confirm timestamp resolution and click **Import**. Files are indexed in parallel and become searchable as soon as ingestion completes.

For timestamp controls, see [Timestamp Resolution](timestamp-resolution.md).

## Search And Analysis

1. Use the search bar to filter logs by time range and keywords.
2. Use the left panel for field-based filtering.
3. Use advanced syntax for field shorthand, regex, exclusions, and boolean operators.
4. Save recurring searches from the workspace menu to restore query, time range, sources, columns, widths, and row coloring later.

## Managing Sources

Every import, live tail or stream becomes a **source** (the `_src` field on each row). Click **Sources** in the left rail to see them all with their row counts; expand one for where it came from, which pattern parsed it, the days it covers and its import history.

- **Rename** gives a source a display name. Searches by the old and new names both keep working — the stored `_src` never changes, and the Filter tab, source chips and the Fields panel keep showing it.
- **Re-import** re-reads a source that was imported by path (Dock drop, Finder "Open With", `POST /ingest/file`) with the same pattern and settings, replacing its rows. Sources uploaded from the browser have no file path to re-read, so the button is disabled for them.
- **Delete** removes a source's rows from every day. The confirmation names the row count; it can't be undone, and it is refused while a live tail or an import is still writing to that source.

**Settings → Storage** shows what is on disk per day with a **Delete** per day, the total size, and where the index lives (in the macOS app, **Reveal in Finder**). It is also where retention is set: **Keep logs for N days** is saved to the index's `config.json` and takes precedence over the `-retention-days` flag — `0` keeps everything. Older days are removed at startup, once a day, and right after you save. See [Retention precedence](configuration.md#retention-precedence) for the full order.

The same operations are available on the API: `GET /api/v1/sources`, `DELETE /api/v1/sources/{name}`, `PATCH /api/v1/sources/{name}`, `POST /api/v1/sources/{name}/reimport`, and `GET`/`PUT /api/v1/storage`, `DELETE /api/v1/storage/days/{date}` — documented in the Swagger UI at `/api/v1/swagger/index.html`.

## MCP Server For AI Clients

LogSonic ships with an MCP server so Claude Desktop, Cursor, Windsurf, and other MCP-capable clients can query your logs.

- Setup: [mcp/README.md](../mcp/README.md)
- Agent playbook: [mcp/SKILLS.md](../mcp/SKILLS.md)

Point your client at the playbook so the model knows which tools and query patterns to use.
