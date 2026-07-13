# Getting Started

## Import Logs

1. Start LogSonic and open `http://localhost:8080`.
2. Click **Import** in the left rail.
3. Drop one or many `.log`, `.txt`, or `.json` files into the file picker.
4. LogSonic auto-detects the format for each file with [log2grok](https://github.com/logsonic/log2grok). If detection succeeds, the wizard shows a **Pattern found** badge with a coverage score. If not, paste a custom Grok pattern and test it inline against a sample.
5. Confirm timestamp resolution and click **Import**. Files are indexed in parallel and become searchable as soon as ingestion completes.

For timestamp controls, see [Timestamp Resolution](timestamp-resolution.md).

## Search And Analysis

1. Use the search bar to filter logs by time range and keywords.
2. Use the left panel for field-based filtering.
3. Use advanced syntax for field shorthand, regex, exclusions, and boolean operators.
4. Save recurring searches from the workspace menu to restore query, time range, sources, columns, widths, and row coloring later.

## MCP Server For AI Clients

LogSonic ships with an MCP server so Claude Desktop, Cursor, Windsurf, and other MCP-capable clients can query your logs.

- Setup: [mcp/README.md](../mcp/README.md)
- Agent playbook: [mcp/SKILLS.md](../mcp/SKILLS.md)

Point your client at the playbook so the model knows which tools and query patterns to use.
