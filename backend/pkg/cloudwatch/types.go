package cloudwatch

import "time"

// ListLogGroupsRequest defines the request parameters for listing CloudWatch log groups
type ListLogGroupsRequest struct {
	Region  string `json:"region,omitempty"`
	Profile string `json:"profile,omitempty"`
}

// ListLogGroupsResponse defines the response for listing CloudWatch log groups
type ListLogGroupsResponse struct {
	Status    string     `json:"status"`
	LogGroups []LogGroup `json:"logGroups"`
	Region    string     `json:"region"`
}

// ListLogStreamsRequest defines the request parameters for listing CloudWatch log streams
type ListLogStreamsRequest struct {
	LogGroupName string     `json:"logGroupName"`
	StartTime    *time.Time `json:"startTime,omitempty"`
	EndTime      *time.Time `json:"endTime,omitempty"`
	Region       string     `json:"region,omitempty"`
	Profile      string     `json:"profile,omitempty"`
}

// ListLogStreamsResponse defines the response for listing CloudWatch log streams
type ListLogStreamsResponse struct {
	Status     string      `json:"status"`
	LogStreams []LogStream `json:"logStreams"`
	Region     string      `json:"region"`
}

// GetLogEventsRequest defines the request parameters for retrieving log events
type GetLogEventsRequest struct {
	LogGroupName  string     `json:"logGroupName"`
	LogStreamName string     `json:"logStreamName"`
	StartTime     *time.Time `json:"startTime,omitempty"`
	EndTime       *time.Time `json:"endTime,omitempty"`
	Region        string     `json:"region,omitempty"`
	Profile       string     `json:"profile,omitempty"`
}

// GetLogEventsResponse defines the response for retrieving log events
type GetLogEventsResponse struct {
	Status    string     `json:"status"`
	LogEvents []LogEvent `json:"logEvents"`
	Region    string     `json:"region"`
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
