// API Types for LogSonic
// Generated from Swagger documentation

// Common Types
export interface ErrorResponse {
  code?: string;
  details?: string;
  error?: string;
  status?: string;
}

// Grok Pattern Types
export interface GrokPatternRequest {
  custom_patterns?: Record<string, string>;
  description: string;
  name: string;
  pattern: string;
  priority: number;
  // Saved alongside the pattern so a recurring import (same source
  // family) restores the user's last-used anchor / year strategy / tz.
  timestamp_config?: TimestampResolution;
}

export interface GrokPatternResponse {
  error?: string;
  patterns?: GrokPatternRequest[];
  status?: string;
}

// Log Ingest Types
export interface IngestRequest {
  logs?: string[];
  session_id?: string;
}

export interface IngestFileRequest {
  session_id: string;
  /** Absolute path to a file the server can read; gzip/zstd detected by magic bytes. */
  path: string;
  /** @deprecated pre-1.7 name of `path`; accepted for one release. */
  log_file_name?: string;
  /** Also ingest app.log.N / app-YYYY-MM-DD.log siblings, oldest first. */
  include_rotated?: boolean;
}

/** The 202 response to POST /ingest/file: the job has been accepted and
 * started in the background. Progress and the final result arrive via
 * IngestJob, either polled from GET /ingest/jobs or pushed as
 * "ingest_progress" SSE events on GET /live/events. */
export interface IngestFileResponse {
  /** "accepted" */
  status: string;
  job_id: string;
  path: string;
  members: string[];
}

/** The live or final state of one path-based ingest. */
export interface IngestJob {
  job_id: string;
  session_id: string;
  path: string;
  members: string[];
  compression?: string;
  bytes_read: number;
  bytes_total?: number;
  lines: number;
  rows_stored: number;
  rows_failed: number;
  rate_lines_per_s: number;
  state: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
}

export interface IngestJobsListResponse {
  jobs: IngestJob[];
}

export interface IngestJobActionResponse {
  /** "cancelling", or the job's terminal state if it had already finished */
  status: string;
}

/** Read the first few lines of a file by absolute path, without creating an
 * ingest session -- the native-drop wizard flow uses this instead of a
 * browser File read, since a native drop only ever has a path. */
export interface PreviewFileRequest {
  path: string;
  /** Caps how many lines to read; default 100, capped server-side. */
  lines?: number;
}

export interface PreviewFileResponse {
  lines: string[];
  /** Exact once the whole file fit within the requested `lines`; otherwise
   * an estimate for an uncompressed file, or just the count of lines
   * actually returned (a lower bound) for a compressed one. */
  approx_lines: number;
  compressed?: string;
  size_bytes: number;
}

export interface IngestResponse {
  error?: string;
  failed?: number;
  filename?: string;
  processed?: number;
  status?: string;
  session_id?: string;
}

export interface IngestSessionOptions {
  name?: string;
  pattern?: string;
  priority?: number;
  custom_patterns?: Record<string, string>;
  source?: string;
  smart_decoder?: boolean;
  force_timezone?: string;
  force_start_year?: string;
  force_start_month?: string;
  force_start_day?: string;
  source_mtime?: string;                  // RFC3339
  timestamp_config?: TimestampResolution;
  meta?: Record<string, any>;
  multiline?: MultilineConfig;
}

// Folds physical lines into logical log records before pattern matching,
// for formats where a single log statement spans multiple lines (stack
// traces, multi-line JSON, etc). Mode "header" treats any line NOT
// matching header_pattern as a continuation of the previous record; mode
// "indent" treats any line starting with a space or tab as a continuation.
export interface MultilineConfig {
  enabled: boolean;
  mode: 'header' | 'indent';
  header_pattern?: string;
  max_lines?: number;
  max_bytes?: number;
}

export interface LiveFileRequest {
  path: string;
  options: IngestSessionOptions;
}

export interface LiveSourceResponse {
  status: string;
  source_id?: string;
  error?: string;
}

export interface LiveControlResponse {
  status: string;
  subscriber_id?: string;
  skipped?: Record<string, number>;
  error?: string;
}

export interface LiveHelloEvent {
  subscriber_id: string;
  source_ids: string[];
}

export interface LiveRowsEvent {
  source_id: string;
  rows: Record<string, any>[];
}

export interface LiveSkippedEvent {
  source_id: string;
  count: number;
  reason: 'paused' | 'overflow' | 'reconnect';
}

export interface LiveSourceStatusEvent {
  source_id: string;
  status: 'started' | 'stopped' | 'error';
  message?: string;
}

// --- Timestamp resolution (mirrors backend pkg/timeresolve) ---

export type TimestampStatus = 'exact' | 'inferred' | 'ambiguous' | 'missing';
export type TimestampConfidence = 'exact' | 'inferred' | 'carried' | 'synthetic';
export type AnchorKind = 'file_mtime' | 'first_parsed' | 'custom' | 'now';
export type YearStrategy = 'parsed' | 'inferred_century' | 'forced' | 'from_anchor';
export type TimezoneKind = 'as_parsed' | 'forced';
export type ForceMode = 'fill_missing' | 'overwrite';

export interface Anchor {
  kind: AnchorKind;
  value: string; // RFC3339
}

export interface TimezoneCfg {
  kind: TimezoneKind;
  value?: string; // IANA zone when kind=forced
}

export interface TimestampResolution {
  anchor: Anchor;
  year_strategy: YearStrategy;
  forced_year?: number;
  forced_month?: number;
  forced_day?: number;
  timezone: TimezoneCfg;
  rollover: boolean;
  force_mode: ForceMode;
  // Names a non-canonical capture (e.g. "bgl_timestamp") to use as
  // the line's timestamp. Empty = canonical scan.
  source_field?: string;
  // Hint for parsing source_field: empty = auto, "unix_seconds",
  // "unix_millis", "unix_nanos", or a Go time layout
  // (e.g. "2006-01-02-15.04.05.000000").
  source_format?: string;
}

export interface FieldCandidate {
  name: string;
  sample: string;
  parses: boolean;
  parsed?: string; // RFC3339 result when parses
  format?: string; // detected format hint
  score?: number;
}

export interface TimestampLayout {
  has_timestamp_field: boolean;
  components_present: string[];
  year_width: number; // 0, 2, or 4
  inferred_format_label: string;
}

export interface TimestampPreviewRow {
  raw: string;
  captured: Record<string, string>;
  resolved: string;
  confidence: TimestampConfidence;
}

export interface TimestampInference {
  status: TimestampStatus;
  layout: TimestampLayout;
  resolution: TimestampResolution;
  preview: TimestampPreviewRow[];
  warnings?: string[];
  field_candidates?: FieldCandidate[];
}

// Log Query Types
export interface LogDistributionEntry {
  count?: number;
  end_time?: string;
  start_time?: string;
  source_counts?: Record<string, number>;
}


export interface FacetValue {
  value: string;
  count: number;
  truncated: boolean;
}

export interface FacetField {
  name: string;
  distinct: number;
  high_cardinality: boolean;
  values: FacetValue[];
}

/** Opt-in (include_facets=true) field/value summary of the search window.
 *  Counts are exact for the `computed_over` rows aggregated; `sampled` means
 *  the window held more rows than the scan cap and only the newest were used. */
export interface FacetsResponse {
  computed_over: number;
  sampled: boolean;
  fields: FacetField[];
}

export interface LogResponse {
  available_columns?: string[];
  count?: number;
  end_date?: string;
  limit?: number;
  log_distribution?: LogDistributionEntry[];
  logs?: Record<string, any>[];
  offset?: number;
  query?: string;
  sort_by?: string;
  sort_order?: string;
  start_date?: string;
  status?: string;
  time_taken?: number;
  index_query_time?: number;
  total_count?: number;
  facets?: FacetsResponse;
}

export interface WorkspaceTime {
  mode: 'relative' | 'absolute';
  relative?: string;
  custom_relative_count?: number;
  custom_relative_unit?: string;
  start?: string;
  end?: string;
}

export interface WorkspaceColorRule {
  id?: string;
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'exists' | 'regex';
  value: string;
  color: string;
  enabled: boolean;
}

export interface WorkspaceVisualization {
  type: 'logs' | 'analytics';
  bucket?: string;
}

// SavedQuery is one starred query+time+source snapshot inside a Workspace
// (spec now-03). Mirrors backend/pkg/types/types.go's SavedQuery.
export interface SavedQuery {
  id: string;
  name: string;
  query?: string;
  time?: WorkspaceTime;
  sources?: string[];
  created_at: string;
}

export interface Workspace {
  id?: string;
  name: string;
  description?: string;
  query?: string;
  sources?: string[];
  time: WorkspaceTime;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  columns?: string[];
  column_widths?: Record<string, number>;
  color_rules?: WorkspaceColorRule[];
  facet_fields?: string[];
  visualization: WorkspaceVisualization;
  favorite?: boolean;
  saved_queries?: SavedQuery[];
  created_at?: string;
  updated_at?: string;
}

export interface WorkspaceListResponse {
  status: string;
  workspaces: Workspace[];
}

export interface WorkspaceResponse {
  status: string;
  workspace: Workspace;
}

// Parse Types
export interface ParseRequest {
  custom_patterns?: Record<string, string>;
  grok_pattern?: string;
  logs?: string[];
  multi?: boolean;
  session_options?: IngestSessionOptions;
}

export interface ParseResponse {
  custom_patterns?: Record<string, string>;
  failed?: number;
  logs?: Record<string, any>[];
  pattern?: string;
  pattern_description?: string;
  processed?: number;
  status?: string;
  timestamp_inference?: TimestampInference;
}

export interface TimestampPreviewRequest {
  logs: string[];
  grok_pattern?: string;
  custom_patterns?: Record<string, string>;
  resolution: Partial<TimestampResolution>;
  source_mtime?: string;
}

export interface TimestampPreviewResponse {
  status: string;
  inference: TimestampInference;
}

// Suggest Types
export interface AutosuggestResult {
  coverage?: number;
  custom_patterns?: Record<string, string>;
  parsed_logs?: Record<string, any>[];
  pattern?: string;
  pattern_description?: string;
  pattern_name?: string;
  score?: number;
  timestamp_field?: string;
  timestamp_layout?: string;
  timestamp_source?: string;
}

export interface SuggestResponse {
  results?: AutosuggestResult[];
  status?: string;
  type?: string;
  combined_coverage?: number;
  multiline?: MultilineConfig;
}

// System Info Types
export interface MemoryUsage {
  alloc_bytes?: number;
  num_gc?: number;
  sys_bytes?: number;
  total_alloc_bytes?: number;
}

export interface SystemInfo {
  architecture?: string;
  go_version?: string;
  hostname?: string;
  memory_usage?: MemoryUsage;
  num_cpu?: number;
  os_type?: string;
}

export interface StorageInfo {
  available_dates?: string[];
  /** Kept for existing readers; `sources` carries the same names with row counts. */
  source_names?: string[];
  sources?: SourceRowsEntry[];
  storage_directory?: string;
  storage_size_bytes?: number;
  total_indices?: number;
  total_log_entries?: number;
}

export interface TokenizerInfo {
  persistent_custom_patterns?: Record<string, string>;
  persistent_patterns?: string[];
}

export interface AppBuildInfo {
  version?: string;
  commit?: string;
  build_date?: string;
}

export interface SystemInfoResponse {
  status?: string;
  app?: AppBuildInfo;
  storage_info?: StorageInfo;
  system_info?: SystemInfo;
}

// --- Sources catalog (mirrors backend pkg/types Source*; spec now-10) ---

/** Compact per-source line on /info. */
export interface SourceRowsEntry {
  name: string;
  rows: number;
}

/** Where a source's rows came from. */
export interface SourceOrigin {
  kind: 'file' | 'stdin' | 'tail' | 'watch' | 'otlp' | 'case' | 'unknown';
  path?: string;
  host?: string;
}

/** One ingest session/job that contributed rows to a source. */
export interface SourceImport {
  at: string;
  rows: number;
  path?: string;
  job_id?: string;
}

/** One row of the sources catalog (`<storage>/sources.json`), keyed by `name` (the stored `_src`). */
export interface SourceEntry {
  name: string;
  /** UI-level rename; the index keeps `name` as `_src`. Every past display name is kept in `aliases`. */
  display_name?: string;
  aliases: string[];
  origin: SourceOrigin;
  pattern_name?: string;
  pattern?: string;
  /** Last path-backed import's options — what a re-import replays. Absent for browser uploads / streams. */
  import_options?: IngestSessionOptions;
  rows: number;
  bytes_raw: number;
  first_ts?: string;
  last_ts?: string;
  /** Every day-index holding rows for this source (sorted); `day_rows` is the per-day count behind it. */
  days: string[];
  day_rows: Record<string, number>;
  created_at: string;
  updated_at: string;
  imports: SourceImport[];
}

/** GET /sources and POST /sources/rebuild. */
export interface SourcesResponse {
  sources: SourceEntry[];
}

/** DELETE /sources/{name}. Not undoable. */
export interface SourceDeleteResponse {
  status: string;
  name: string;
  rows_deleted: number;
  days_touched: string[];
  /** Day-indices deleted from disk because the source was the last thing in them. */
  days_removed: string[];
}

/** PATCH /sources/{name} body; empty clears the display name. */
export interface SourceRenameRequest {
  display_name: string;
}

/** POST /sources/{name}/reimport (202): old rows gone, a path-ingest job is running. */
export interface SourceReimportResponse {
  status: string;
  job_id: string;
  session_id: string;
  path: string;
  rows_deleted: number;
}

// --- Storage settings (mirrors backend pkg/types Storage*; spec now-10) ---

/** One row of the per-day table on GET /storage. */
export interface StorageDay {
  date: string;
  rows: number;
  bytes: number;
}

/** GET /storage and PUT /storage. */
export interface StorageResponse {
  status: string;
  /** Retention in effect; 0 = keep everything. */
  retention_days: number;
  /** Where it came from: `config.json` (set from the UI), the CLI flag/env, or nothing. */
  retention_source: 'config' | 'flag' | 'none';
  /** The flag/env value clearing the override falls back to. */
  retention_default: number;
  days: StorageDay[];
  /** Sum of the day-index directories only (not the whole storage dir). */
  total_bytes: number;
  path: string;
  config_path: string;
}

/** PUT /storage body. `null` clears the override; 0 keeps everything. */
export interface StorageUpdateRequest {
  retention_days: number | null;
}

/** DELETE /storage/days/{date}. Not undoable. */
export interface StorageDayDeleteResponse {
  status: string;
  date: string;
  rows_deleted: number;
}

// --- Folder watches (mirrors backend pkg/types Watch*; spec now-04) ---

/** Create a folder watch: matching files in `dir` are ingested when they appear and followed as they grow. */
export interface WatchRequest {
  /** Absolute path of an existing directory. */
  dir: string;
  /** Base-name glob, default `*.log`. */
  glob?: string;
  /** `""` or `"auto"` for per-file detection, else a saved Grok pattern name. */
  pattern?: string;
  recursive?: boolean;
}

/** One tracked file. `done` = a compressed file's one-shot ingest finished; `skipped` = beyond the 100-file cap. */
export interface WatchFile {
  path: string;
  offset: number;
  size: number;
  state: 'pending' | 'ingesting' | 'following' | 'done' | 'skipped' | 'error';
  error?: string;
  /** The `_src` rows are stored under: `watch.<dirname>.<filename>`. */
  source: string;
  pattern?: string;
}

/** A folder watch with its live file snapshot. The server always fills `glob` (default `*.log`). */
export interface Watch extends Omit<WatchRequest, 'glob'> {
  id: string;
  glob: string;
  paused: boolean;
  created_at: string;
  /** Set while the directory itself can't be read; cleared when it can. */
  error?: string;
  files: WatchFile[];
}

/** GET /watches. */
export interface WatchesResponse {
  watches: Watch[];
}

// --- Bundled samples and UI focus (mirrors backend pkg/types; spec now-12) ---

/** One sample log embedded in the binary. */
export interface SampleInfo {
  name: string;
  description: string;
  lines: number;
  bytes: number;
  license: string;
  /** The `_src` it imports under. */
  source: string;
  pattern_name: string;
}

/** GET /samples. */
export interface SamplesResponse {
  samples: SampleInfo[];
}

/** POST /ui/focus body: bring the app window to the front, optionally at a `#/...` route. */
export interface UIFocusRequest {
  route?: string;
}

/** The `ui_focus` SSE event on /live/events. */
export interface UIFocusEvent {
  route?: string;
}

// Query Parameters
export interface LogQueryParams {
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: string;
  start_date?: string;
  end_date?: string;
  query?: string;
  _src?: string;
  /** Comma-separated response fields; omitted on the first discovery search. */
  fields?: string;
  /** Defer the chart aggregation so the first result rows are not blocked by it. */
  include_distribution?: boolean;
  include_facets?: boolean;
}
