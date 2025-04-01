// CloudWatch API Types
// Generated from backend swagger definitions

// Authentication
export interface CloudWatchAuth {
  region: string;
  profile?: string;
}

// Log structure types
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
}

export interface CloudWatchLogEvent {
  timestamp: string | Date;
  message: string;
  logStream: string;
  logGroup: string;
}

// Request/response types
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
  log_events: Array<{
    timestamp: number;
    message: string;
    log_stream: string;
    log_group: string;
  }>;
  region: string;
  next_token?: string;
  has_more: boolean;
}

// Selection state types
export interface SelectedStream {
  groupName: string;
  streamName: string;
}

// Pagination state
export interface LogPaginationState {
  nextToken: string | null;
  hasMore: boolean;
  isLoading: boolean;
}

// Import types
export interface ImportCloudWatchLogsRequest {
  logGroups: string[];
  logStreams?: string[];
  startTime?: Date;
  endTime?: Date;
  region?: string;
  profile?: string;
}

export interface ImportCloudWatchLogsResponse {
  status: string;
  logCount: number;
  successCount: number;
  failedCount: number;
  processingTime: string;
} 