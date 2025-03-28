package cloudwatch

import "time"

// ListLogGroupsRequest represents the request to list log groups
type ListLogGroupsRequest struct {
	Region  string `json:"region"`
	Profile string `json:"profile,omitempty"`
}

// ListLogGroupsResponse represents the response from listing log groups
type ListLogGroupsResponse struct {
	Status    string   `json:"status"`
	LogGroups []string `json:"log_groups"`
	Region    string   `json:"region"`
}

// ListLogStreamsRequest represents the request to list log streams
type ListLogStreamsRequest struct {
	LogGroupName string `json:"log_group_name"`
	Region       string `json:"region"`
	Profile      string `json:"profile,omitempty"`
	StartTime    int64  `json:"start_time,omitempty"`
	EndTime      int64  `json:"end_time,omitempty"`
}

// ListLogStreamsResponse represents the response from listing log streams
type ListLogStreamsResponse struct {
	Status     string   `json:"status"`
	LogStreams []string `json:"log_streams"`
	Region     string   `json:"region"`
}

// GetLogEventsRequest represents the request to get log events
type GetLogEventsRequest struct {
	LogGroupName  string `json:"log_group_name"`
	LogStreamName string `json:"log_stream_name"`
	Region        string `json:"region"`
	Profile       string `json:"profile,omitempty"`
	StartTime     int64  `json:"start_time,omitempty"`
	EndTime       int64  `json:"end_time,omitempty"`
	NextToken     string `json:"next_token,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

// GetLogEventsResponse represents the response from getting log events
type GetLogEventsResponse struct {
	Status    string                   `json:"status"`
	LogEvents []map[string]interface{} `json:"log_events"`
	Region    string                   `json:"region"`
	NextToken string                   `json:"next_token,omitempty"`
	HasMore   bool                     `json:"has_more"`
}

// ImportCloudWatchLogsRequest defines the request parameters for importing CloudWatch logs
type ImportCloudWatchLogsRequest struct {
	LogGroups  []string   `json:"logGroups"`
	LogStreams []string   `json:"logStreams,omitempty"`
	StartTime  *time.Time `json:"startTime,omitempty"`
	EndTime    *time.Time `json:"endTime,omitempty"`
	Region     string     `json:"region,omitempty"`
	Profile    string     `json:"profile,omitempty"`
}

// ImportCloudWatchLogsResponse defines the response for importing CloudWatch logs
type ImportCloudWatchLogsResponse struct {
	Status         string `json:"status"`
	LogCount       int    `json:"logCount"`
	SuccessCount   int    `json:"successCount"`
	FailedCount    int    `json:"failedCount"`
	ProcessingTime string `json:"processingTime"`
}
