# Timestamp Resolution

LogSonic resolves a real wall-clock timestamp for every log line, even when the line itself does not carry a complete date. The resolver runs during import and surfaces diagnostics in the wizard so you can confirm or override what it deduced before indexing.

## What The Resolver Auto-Detects

The Grok pattern emits captures per line. The resolver looks at canonical timestamp captures and composes a timestamp from whatever is available, in this priority order:

| What the line carries | Example | What the resolver does |
|---|---|---|
| Full year-qualified timestamp | `2015-10-18 18:01:47,978`, `01/Apr/2026:00:00:56 +0000` | Parses directly. |
| Components with 4-digit year | `date=20171223 hour=22 minute=15` | Composes from atomic fields. |
| Components with 2-digit year | `year=17 month=06 day=09 time=20:10:40` | Expands the century against the anchor. |
| Year-less timestamp | `Jun 14 15:16:01` | Borrows the year from the anchor and detects Dec-to-Jan rollover. |
| Time-only continuation lines | `20:10:41` after a fully stamped line | Carries the prior line's date forward and detects midnight rollover. |
| No recognizable time | Bare app messages | Falls back to the anchor and flags the file as synthetic. |

The anchor is the absolute reference used to fill missing components. It is chosen automatically:

1. Source file modification time, when LogSonic knows it.
2. The first fully qualified timestamp in the sample.
3. Wall-clock now as a last resort.

The import wizard previews each row's resolved timestamp with a confidence label: `exact`, `inferred`, `carried`, or `synthetic`.

## When To Override

Override timestamp resolution when:

- The file modification time is not representative of the content.
- The file has 2-digit years and the anchor is not close to the log content.
- Logs are in a non-UTC timezone but do not carry an offset.
- You know the year for a year-less file.
- A multi-day file spans a Dec-to-Jan boundary and rollover detection guesses wrong.

The wizard previews the first few resolved lines as you change controls. Once confirmed, the configuration is sent with the ingest request and applied to every line in the file.

## CLI And API Users

When ingesting via the API directly, pass:

- `source_mtime` as RFC3339 on `/ingest/start` to anchor against the file's modification time.
- `timestamp_config` on `/ingest/start` with `{ anchor, year_strategy, forced_year, timezone, rollover, force_mode }`.

Without either, the resolver derives sensible defaults from the sample. Legacy fields such as `force_start_year`, `force_start_month`, `force_start_day`, and `force_timezone` still work and are translated to a resolution with `force_mode=overwrite`.
