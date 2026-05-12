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
  log_file_name?: string;
  session_id?: string;
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
}

// Parse Types
export interface ParseRequest {
  custom_patterns?: Record<string, string>;
  grok_pattern?: string;
  logs?: string[];
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
  custom_patterns?: Record<string, string>;
  parsed_logs?: Record<string, any>[];
  pattern?: string;
  pattern_description?: string;
  pattern_name?: string;
  score?: number;
}

export interface SuggestResponse {
  results?: AutosuggestResult[];
  status?: string;
  type?: string;
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
  source_names?: string[];
  storage_directory?: string;
  storage_size_bytes?: number;
  total_indices?: number;
  total_log_entries?: number;
}

export interface TokenizerInfo {
  persistent_custom_patterns?: Record<string, string>;
  persistent_patterns?: string[];
}

export interface SystemInfoResponse {
  status?: string;
  storage_info?: StorageInfo;
  system_info?: SystemInfo;
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
} 