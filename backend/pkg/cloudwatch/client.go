package cloudwatch

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
)

// ClientInterface defines methods to interact with CloudWatch Logs
type ClientInterface interface {
	ListLogGroups(ctx context.Context) ([]LogGroup, error)
	ListLogStreams(ctx context.Context, logGroupName string, startTime, endTime *time.Time) ([]LogStream, error)
	GetLogEvents(ctx context.Context, logGroupName, logStreamName string, startTime, endTime *time.Time, nextToken *string, limit int) ([]LogEvent, string, bool, error)
}

// Client implements CloudWatchClientInterface
type Client struct {
	cwLogsClient *cloudwatchlogs.Client
	region       string
}

// LogGroup represents a CloudWatch log group
type LogGroup struct {
	Name          string    `json:"name"`
	ARN           string    `json:"arn"`
	CreationTime  time.Time `json:"creationTime"`
	StoredBytes   int64     `json:"storedBytes"`
	RetentionDays int       `json:"retentionDays"`
}

// LogStream represents a CloudWatch log stream
type LogStream struct {
	Name           string    `json:"name"`
	LogGroupName   string    `json:"logGroupName"`
	CreationTime   time.Time `json:"creationTime"`
	FirstEventTime time.Time `json:"firstEventTime"`
	LastEventTime  time.Time `json:"lastEventTime"`
	StoredBytes    int64     `json:"storedBytes"`
}

// LogEvent represents a CloudWatch log event
type LogEvent struct {
	Timestamp time.Time `json:"timestamp"`
	Message   string    `json:"message"`
	LogStream string    `json:"logStream"`
	LogGroup  string    `json:"logGroup"`
}

// Config holds the configuration for the CloudWatch client
type Config struct {
	Region  string
	Profile string
}

// NewClient creates a new CloudWatch client
func NewClient(cfg Config) (*Client, error) {
	var awsConfig aws.Config
	var err error

	ctx := context.Background()

	// Try to load AWS configuration from different sources in order:
	// 1. Named profile if provided
	// 2. Default AWS config from environment or credentials file

	if cfg.Profile != "" {
		// Use named profile
		awsConfig, err = config.LoadDefaultConfig(ctx,
			config.WithSharedConfigProfile(cfg.Profile),
		)
	} else {
		// Use default configuration
		awsConfig, err = config.LoadDefaultConfig(ctx)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to load AWS configuration: %w", err)
	}

	// Override region if specified
	if cfg.Region != "" {
		awsConfig.Region = cfg.Region
	}

	cwLogsClient := cloudwatchlogs.NewFromConfig(awsConfig)

	return &Client{
		cwLogsClient: cwLogsClient,
		region:       awsConfig.Region,
	}, nil
}

// ListLogGroups lists all log groups in the AWS account
func (c *Client) ListLogGroups(ctx context.Context) ([]LogGroup, error) {
	var logGroups []LogGroup
	var nextToken *string

	for {
		resp, err := c.cwLogsClient.DescribeLogGroups(ctx, &cloudwatchlogs.DescribeLogGroupsInput{
			NextToken: nextToken,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to describe log groups: %w", err)
		}

		for _, lg := range resp.LogGroups {
			creationTime := time.Time{}
			if lg.CreationTime != nil {
				creationTime = time.UnixMilli(*lg.CreationTime)
			}

			storedBytes := int64(0)
			if lg.StoredBytes != nil {
				storedBytes = *lg.StoredBytes
			}

			retentionDays := 0
			if lg.RetentionInDays != nil {
				retentionDays = int(*lg.RetentionInDays)
			}

			logGroups = append(logGroups, LogGroup{
				Name:          aws.ToString(lg.LogGroupName),
				ARN:           aws.ToString(lg.Arn),
				CreationTime:  creationTime,
				StoredBytes:   storedBytes,
				RetentionDays: retentionDays,
			})
		}

		nextToken = resp.NextToken
		if nextToken == nil {
			break
		}
	}

	return logGroups, nil
}

// ListLogStreams lists log streams for a log group with optional time filtering
func (c *Client) ListLogStreams(ctx context.Context, logGroupName string, startTime, endTime *time.Time) ([]LogStream, error) {
	var logStreams []LogStream
	var nextToken *string

	for {
		input := &cloudwatchlogs.DescribeLogStreamsInput{
			LogGroupName: aws.String(logGroupName),
			OrderBy:      "LastEventTime", // Use string value instead of enum
			Descending:   aws.Bool(true),
			NextToken:    nextToken,
		}

		resp, err := c.cwLogsClient.DescribeLogStreams(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("failed to describe log streams: %w", err)
		}

		for _, ls := range resp.LogStreams {
			// Skip streams that don't have events in the specified time range
			if startTime != nil && ls.LastEventTimestamp != nil && *ls.LastEventTimestamp < startTime.UnixMilli() {
				continue
			}
			if endTime != nil && ls.FirstEventTimestamp != nil && *ls.FirstEventTimestamp > endTime.UnixMilli() {
				continue
			}

			stream := LogStream{
				Name:         aws.ToString(ls.LogStreamName),
				LogGroupName: logGroupName,
				StoredBytes:  0,
			}

			if ls.CreationTime != nil {
				stream.CreationTime = time.UnixMilli(*ls.CreationTime)
			}

			if ls.StoredBytes != nil {
				stream.StoredBytes = *ls.StoredBytes
			}

			if ls.FirstEventTimestamp != nil {
				stream.FirstEventTime = time.UnixMilli(*ls.FirstEventTimestamp)
			}

			if ls.LastEventTimestamp != nil {
				stream.LastEventTime = time.UnixMilli(*ls.LastEventTimestamp)
			}

			logStreams = append(logStreams, stream)
		}

		nextToken = resp.NextToken
		if nextToken == nil {
			break
		}
	}

	return logStreams, nil
}

// GetLogEvents retrieves log events from a specific log stream in a time range
// with support for pagination to limit the number of logs retrieved in a single request
func (c *Client) GetLogEvents(ctx context.Context, logGroupName, logStreamName string, startTime, endTime *time.Time, nextToken *string, limit int) ([]LogEvent, string, bool, error) {
	var logEvents []LogEvent

	// Default to 10000 if no limit is specified or limit is too large
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}

	input := &cloudwatchlogs.GetLogEventsInput{
		LogGroupName:  aws.String(logGroupName),
		LogStreamName: aws.String(logStreamName),
		StartFromHead: aws.Bool(true),          // Start from the oldest log events
		Limit:         aws.Int32(int32(limit)), // Set the limit from parameter
	}

	if startTime != nil {
		input.StartTime = aws.Int64(startTime.UnixMilli())
	}

	if endTime != nil {
		input.EndTime = aws.Int64(endTime.UnixMilli())
	}

	// Use the provided pagination token if available
	if nextToken != nil && *nextToken != "" {
		input.NextToken = nextToken
	}

	// We'll make just one request and return its results with pagination info
	resp, err := c.cwLogsClient.GetLogEvents(ctx, input)
	if err != nil {
		return nil, "", false, fmt.Errorf("failed to get log events: %w", err)
	}

	for _, event := range resp.Events {
		logEvents = append(logEvents, LogEvent{
			Timestamp: time.UnixMilli(aws.ToInt64(event.Timestamp)),
			Message:   aws.ToString(event.Message),
			LogStream: logStreamName,
			LogGroup:  logGroupName,
		})
	}

	// Determine if there are more results available
	var returnToken string
	if resp.NextForwardToken != nil {
		returnToken = *resp.NextForwardToken
	}

	// Check if this is the last page
	hasMore := true
	if nextToken != nil && resp.NextForwardToken != nil && *nextToken == *resp.NextForwardToken {
		hasMore = false
	}

	// If we got fewer events than the limit, it's likely the last page
	if len(resp.Events) < limit {
		hasMore = false
	}

	return logEvents, returnToken, hasMore, nil
}

// GetRegion returns the AWS region configured for this client
func (c *Client) GetRegion() string {
	return c.region
}
