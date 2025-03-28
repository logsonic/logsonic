package handlers

import (
	"context"
	"encoding/json"
	"logsonic/pkg/cloudwatch"
	"logsonic/pkg/types"
	"net/http"
	"time"
)

// @Summary List CloudWatch log groups
// @Description List all CloudWatch log groups in the specified AWS account
// @Tags cloudwatch
// @Accept json
// @Produce json
// @Param request body cloudwatch.ListLogGroupsRequest true "AWS auth and region parameters"
// @Success 200 {object} cloudwatch.ListLogGroupsResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /cloudwatch/log-groups [post]
func (h *Services) HandleListCloudWatchLogGroups(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req cloudwatch.ListLogGroupsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_REQUEST",
			Details: err.Error(),
		})
		return
	}

	// Create CloudWatch client
	cwClient, err := cloudwatch.NewClient(cloudwatch.Config{
		Region:  req.Region,
		Profile: req.Profile,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to create CloudWatch client",
			Code:    "AWS_CLIENT_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Set a timeout for the context
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// List log groups
	logGroups, err := cwClient.ListLogGroups(ctx)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to list CloudWatch log groups",
			Code:    "AWS_API_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Convert LogGroup objects to strings containing the group names
	logGroupNames := make([]string, 0, len(logGroups))
	for _, group := range logGroups {
		logGroupNames = append(logGroupNames, group.Name)
	}

	// Return successful response
	json.NewEncoder(w).Encode(cloudwatch.ListLogGroupsResponse{
		Status:    "success",
		LogGroups: logGroupNames,
		Region:    cwClient.GetRegion(),
	})
}

// @Summary List CloudWatch log streams
// @Description List CloudWatch log streams in a log group for the specified time range
// @Tags cloudwatch
// @Accept json
// @Produce json
// @Param request body cloudwatch.ListLogStreamsRequest true "Log group and time range parameters"
// @Success 200 {object} cloudwatch.ListLogStreamsResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /cloudwatch/log-streams [post]
func (h *Services) HandleListCloudWatchLogStreams(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req cloudwatch.ListLogStreamsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_REQUEST",
			Details: err.Error(),
		})
		return
	}

	// Validate required fields
	if req.LogGroupName == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Log group name is required",
			Code:   "MISSING_LOG_GROUP",
		})
		return
	}

	// Create CloudWatch client
	cwClient, err := cloudwatch.NewClient(cloudwatch.Config{
		Region:  req.Region,
		Profile: req.Profile,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to create CloudWatch client",
			Code:    "AWS_CLIENT_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Set a timeout for the context
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Convert epoch timestamps to time.Time if provided
	var startTime, endTime *time.Time
	if req.StartTime > 0 {
		st := time.Unix(0, req.StartTime*int64(time.Millisecond))
		startTime = &st
	}
	if req.EndTime > 0 {
		et := time.Unix(0, req.EndTime*int64(time.Millisecond))
		endTime = &et
	}

	// List log streams
	logStreams, err := cwClient.ListLogStreams(ctx, req.LogGroupName, startTime, endTime)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to list CloudWatch log streams",
			Code:    "AWS_API_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Convert LogStream objects to strings containing the stream names
	logStreamNames := make([]string, 0, len(logStreams))
	for _, stream := range logStreams {
		logStreamNames = append(logStreamNames, stream.Name)
	}

	// Return successful response
	json.NewEncoder(w).Encode(cloudwatch.ListLogStreamsResponse{
		Status:     "success",
		LogStreams: logStreamNames,
		Region:     cwClient.GetRegion(),
	})
}

// @Summary Get CloudWatch log events
// @Description Get log events from a specific CloudWatch log stream in a time range
// @Tags cloudwatch
// @Accept json
// @Produce json
// @Param request body cloudwatch.GetLogEventsRequest true "Log stream and time range parameters"
// @Success 200 {object} cloudwatch.GetLogEventsResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /cloudwatch/log-events [post]
func (h *Services) HandleGetCloudWatchLogEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req cloudwatch.GetLogEventsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_REQUEST",
			Details: err.Error(),
		})
		return
	}

	// Validate required fields
	if req.LogGroupName == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Log group name is required",
			Code:   "MISSING_LOG_GROUP",
		})
		return
	}

	if req.LogStreamName == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Log stream name is required",
			Code:   "MISSING_LOG_STREAM",
		})
		return
	}

	// Create CloudWatch client
	cwClient, err := cloudwatch.NewClient(cloudwatch.Config{
		Region:  req.Region,
		Profile: req.Profile,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to create CloudWatch client",
			Code:    "AWS_CLIENT_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Set a timeout for the context
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Convert epoch timestamps to time.Time if provided
	var startTime, endTime *time.Time
	if req.StartTime > 0 {
		st := time.Unix(0, req.StartTime*int64(time.Millisecond))
		startTime = &st
	}
	if req.EndTime > 0 {
		et := time.Unix(0, req.EndTime*int64(time.Millisecond))
		endTime = &et
	}

	// Set default limit if not provided
	limit := 10000
	if req.Limit > 0 && req.Limit < 10000 {
		limit = req.Limit
	}

	// Use token for pagination if provided
	var nextToken *string
	if req.NextToken != "" {
		nextToken = &req.NextToken
	}

	// Get log events with pagination support
	logEvents, token, hasMore, err := cwClient.GetLogEvents(ctx, req.LogGroupName, req.LogStreamName, startTime, endTime, nextToken, limit)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to get CloudWatch log events",
			Code:    "AWS_API_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Convert LogEvent objects to maps for the response
	eventMaps := make([]map[string]interface{}, 0, len(logEvents))
	for _, event := range logEvents {
		eventMap := map[string]interface{}{
			"timestamp":  event.Timestamp.UnixMilli(),
			"message":    event.Message,
			"log_stream": event.LogStream,
			"log_group":  event.LogGroup,
		}
		eventMaps = append(eventMaps, eventMap)
	}

	// Return successful response with pagination information
	json.NewEncoder(w).Encode(cloudwatch.GetLogEventsResponse{
		Status:    "success",
		LogEvents: eventMaps,
		Region:    cwClient.GetRegion(),
		NextToken: token,
		HasMore:   hasMore,
	})
}
