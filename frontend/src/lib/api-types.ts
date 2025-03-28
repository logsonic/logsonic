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
  meta?: Record<string, any>;
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

// CloudWatch Types
export interface CloudWatchAuth {
  region?: string;
  profile?: string;
}

export interface CloudWatchLogGroup {
  name: string;
  arn: string;
  creationTime: string | Date;
  storedBytes: number;
  retentionDays: number;
  streams?: CloudWatchLogStream[];
}

export interface CloudWatchLogStream {
  name: string;
  logGroupName: string;
  creationTime: string | Date;
  firstEventTime: string | Date;
  lastEventTime: string | Date;
  storedBytes: number;
  // Include snake_case versions for compatibility
  log_group_name?: string;
  creation_time?: string | Date; 
  first_event_time?: string | Date;
  last_event_time?: string | Date;
  stored_bytes?: number;
}

export interface CloudWatchLogEvent {
  timestamp: string | Date;
  message: string;
  logStream: string;
  logGroup: string;
}

export interface ListLogGroupsRequest extends CloudWatchAuth {}

export interface ListLogGroupsResponse {
  status: string;
  log_groups: CloudWatchLogGroup[];
  region: string;
}

export interface ListLogStreamsRequest extends CloudWatchAuth {
  log_group_name: string;
  start_time?: number;
  end_time?: number;
}

export interface ListLogStreamsResponse {
  status: string;
  log_streams: CloudWatchLogStream[];
  region: string;
}

export interface GetLogEventsRequest extends CloudWatchAuth {
  log_group_name: string;
  log_stream_name: string;
  start_time?: number;
  end_time?: number;
  next_token?: string;
  limit?: number;
}

export interface GetLogEventsResponse {
  status: string;
  log_events: any[];
  region: string;
  next_token?: string;
  has_more: boolean;
}

export interface SelectedCloudWatchLog {
  log_group_name: string;
  selected: boolean;
  streams?: CloudWatchLogStream[];
  selectedStreams?: string[];
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