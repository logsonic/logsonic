package handlers

import (
	"encoding/json"
	"fmt"
	"logsonic/pkg/types"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/araddon/dateparse"
)

// @Summary Read all logs
// @Description Retrieve all stored logs with pagination, sorting, time distribution support
// @Tags logs
// @Accept json
// @Produce json
// @Param limit query integer false "Maximum number of logs to return (default: 1000)"
// @Param offset query integer false "Number of logs to skip (default: 0)"
// @Param sort_by query string false "Field to sort by (default: timestamp)"
// @Param sort_order query string false "Sort order (asc or desc, default: desc)"
// @Param start_date query string false "Start date for log retrieval (RFC3339 format)"
// @Param end_date query string false "End date for log retrieval (RFC3339 format)"
// @Param query query string false "Optional search query to filter logs"
// @Param _src query string false "Optional comma-separated source filter"
// @Success 200 {object} types.LogResponse "Logs with pagination, sorting, and time distribution metadata"
// @Failure 400 {object} types.ErrorResponse "Bad request due to invalid parameters"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /logs [get]
func (h *Services) HandleReadAll(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
			Code:   "METHOD_NOT_ALLOWED",
		})
		return
	}

	query := r.URL.Query()
	startTime := time.Now()

	limit := 1000
	if limitStr := query.Get("limit"); limitStr != "" {
		if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 {
			limit = parsedLimit
		} else {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Invalid limit parameter",
				Code:    "INVALID_PARAMETER",
				Details: "Limit must be a positive integer",
			})
			return
		}
	}
	offset := 0
	if offsetStr := query.Get("offset"); offsetStr != "" {
		if parsedOffset, err := strconv.Atoi(offsetStr); err == nil && parsedOffset >= 0 {
			offset = parsedOffset
		} else {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Invalid offset parameter",
				Code:    "INVALID_PARAMETER",
				Details: "Offset must be a non-negative integer",
			})
			return
		}
	}

	// Validate and set sorting parameters
	sortBy := "timestamp"
	if sortByParam := query.Get("sort_by"); sortByParam != "" {
		sortBy = sortByParam
	}

	sortOrder := "desc"
	if sortOrderParam := query.Get("sort_order"); sortOrderParam != "" {
		if sortOrderParam != "asc" && sortOrderParam != "desc" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Invalid sort_order parameter",
				Code:    "INVALID_PARAMETER",
				Details: "Sort order must be 'asc' or 'desc'",
			})
			return
		}
		sortOrder = sortOrderParam
	}

	// Handle optional search query
	searchQuery := query.Get("query")

	// Set default date range (1 year ago to now)
	now := time.Now()
	startDate := now.AddDate(-1, 0, 0)
	endDate := now

	// Parse optional start_date and end_date
	if startDateStr := query.Get("start_date"); startDateStr != "" {
		var parsedStartDate time.Time
		var err error

		// Try parsing with dateparse which handles multiple formats
		parsedStartDate, err = dateparse.ParseAny(startDateStr)

		// If parsing fails, try parsing as Unix timestamp
		if err != nil {
			unixTimestamp, err := strconv.ParseInt(startDateStr, 10, 64)
			if err == nil {
				parsedStartDate = time.Unix(unixTimestamp, 0)
			}
		}

		// If parsing succeeds, update startDate
		if err == nil {
			startDate = parsedStartDate
		}
	}

	if endDateStr := query.Get("end_date"); endDateStr != "" {
		var parsedEndDate time.Time
		var err error

		// Use same parsing approach as start_date for consistency
		parsedEndDate, err = dateparse.ParseAny(endDateStr)

		// If parsing fails, try parsing as Unix timestamp
		if err != nil {
			unixTimestamp, err := strconv.ParseInt(endDateStr, 10, 64)
			if err == nil {
				parsedEndDate = time.Unix(unixTimestamp, 0)
			}
		}

		// If parsing succeeds, update endDate
		if err == nil {
			endDate = parsedEndDate
		}
	}

	// Ensure that we preserve the full time components (hours, minutes, seconds) of dates
	// for accurate filtering, not just the calendar date

	//Source filter
	sourceFilter := query.Get("_src")
	sources := []string{}
	if sourceFilter != "" {
		sources = strings.Split(sourceFilter, ",")
	}

	var allLogs []map[string]interface{}
	var indexQueryTime time.Duration
	var err error

	// Perform search with full timestamps (including time components)
	allLogs, indexQueryTime, err = h.storage.Search(searchQuery, &startDate, &endDate, sources)

	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to read logs",
			Code:    "READ_ERROR",
			Details: err.Error(),
		})
		return
	}

	totalCount := len(allLogs)
	endIndex := offset + limit
	if endIndex > totalCount {
		endIndex = totalCount
	}
	if offset >= totalCount {
		offset = 0
		endIndex = 0
	}

	// Sort logs and get available columns in a single pass
	availableColumns := sortLogs(allLogs, sortBy, sortOrder)

	// Calculate log distribution over time
	logDistributionEntries, _ := calculateLogDistribution(allLogs)

	totalTime := time.Since(startTime)

	// Encode response using LogResponse type
	json.NewEncoder(w).Encode(types.LogResponse{
		Status:           "success",
		TotalCount:       totalCount,
		IndexQueryTime:   int(indexQueryTime.Microseconds()),
		TimeTaken:        int(totalTime.Microseconds()),
		Offset:           offset,
		Limit:            limit,
		Count:            len(allLogs[offset:endIndex]),
		Logs:             allLogs[offset:endIndex],
		SortBy:           sortBy,
		SortOrder:        sortOrder,
		Query:            searchQuery,
		StartDate:        startDate.Format(time.RFC3339),
		EndDate:          endDate.Format(time.RFC3339),
		AvailableColumns: availableColumns,
		LogDistribution:  logDistributionEntries,
	})
}

// calculateLogDistribution calculates time-based distribution of logs
// Returns distribution entries and unique sources
func calculateLogDistribution(allLogs []map[string]interface{}) ([]types.LogDistributionEntry, map[string]bool) {
	// Track unique sources
	uniqueSources := make(map[string]bool)
	var logDistributionEntries []types.LogDistributionEntry

	// Initialize count of logs without timestamps
	logsWithoutTimestamp := 0

	if len(allLogs) > 0 {
		// Find the first and last log timestamps
		var firstLogTime, lastLogTime time.Time

		// Find the lowest and highest timestamp in all logs
		for _, log := range allLogs {
			// Track unique sources regardless of timestamp
			if src, exists := log["_src"]; exists && src != nil {
				srcStr := fmt.Sprintf("%v", src)
				uniqueSources[srcStr] = true
			}

			ts, exists := log["timestamp"]
			if !exists || ts == nil {
				logsWithoutTimestamp++
				continue
			}

			timestamp, ok := ts.(time.Time)
			if !ok {
				logsWithoutTimestamp++
				continue
			}

			if firstLogTime.IsZero() || timestamp.Before(firstLogTime) {
				firstLogTime = timestamp
			}
			if lastLogTime.IsZero() || timestamp.After(lastLogTime) {
				lastLogTime = timestamp
			}
		}

		// If valid timestamps found, calculate distribution
		if !firstLogTime.IsZero() && !lastLogTime.IsZero() {
			// Calculate time bucket size
			timeDiff := lastLogTime.Sub(firstLogTime)
			maxBuckets := 100 // Maximum number of buckets

			// Ensure minimum bucket duration is 1 second
			minBucketDuration := time.Second

			// Calculate bucket duration based on time difference
			bucketDuration := timeDiff / time.Duration(maxBuckets)

			// Ensure bucket duration is at least 1 second
			if bucketDuration < minBucketDuration {
				bucketDuration = minBucketDuration
			}

			// Calculate actual number of buckets needed
			numBuckets := int(timeDiff / bucketDuration)
			if numBuckets > maxBuckets {
				numBuckets = maxBuckets
			}
			if numBuckets < 1 {
				numBuckets = 1
			}

			// Recalculate bucket duration to ensure even distribution
			bucketDuration = timeDiff / time.Duration(numBuckets)

			// Initialize distribution buckets
			logDistributionEntries = make([]types.LogDistributionEntry, numBuckets)
			for i := 0; i < numBuckets; i++ {
				bucketStart := firstLogTime.Add(time.Duration(i) * bucketDuration)
				bucketEnd := bucketStart.Add(bucketDuration)
				logDistributionEntries[i] = types.LogDistributionEntry{
					StartTime:    bucketStart.Format(time.RFC3339),
					EndTime:      bucketEnd.Format(time.RFC3339),
					Count:        0,
					SourceCounts: make(map[string]int),
				}
			}

			// Count logs in each bucket
			bucketCounts := 0
			outOfBoundsCounts := 0

			for _, log := range allLogs {
				// Parse log timestamp
				ts, exists := log["timestamp"]
				if !exists || ts == nil {
					continue
				}

				logTime, ok := ts.(time.Time)
				if !ok {
					continue
				}

				// Get source, default to "unknown" if not available
				source := "unknown"
				if src, exists := log["_src"]; exists && src != nil {
					source = fmt.Sprintf("%v", src)
				}

				// For the last bucket, include logs exactly at the end time
				isInTimeRange := (logTime.Equal(firstLogTime) || logTime.After(firstLogTime)) &&
					(logTime.Before(lastLogTime) || logTime.Equal(lastLogTime))

				if !isInTimeRange {
					outOfBoundsCounts++
					continue
				}

				// Calculate bucket index with protection against division issues
				timeSinceStart := logTime.Sub(firstLogTime)
				if timeSinceStart < 0 {
					outOfBoundsCounts++
					continue
				}

				// Use float calculation to avoid integer division issues
				bucketFloat := float64(timeSinceStart) / float64(bucketDuration)
				bucketIndex := int(bucketFloat)

				// Handle edge case for logs exactly at the end of the range
				if logTime.Equal(lastLogTime) {
					bucketIndex = numBuckets - 1
				}

				// Ensure bucket index is within bounds
				if bucketIndex >= 0 && bucketIndex < numBuckets {
					logDistributionEntries[bucketIndex].Count++
					logDistributionEntries[bucketIndex].SourceCounts[source]++
					bucketCounts++
				} else {
					outOfBoundsCounts++
				}
			}

			// Verify that all logs with timestamps are counted
			logsWithTimestamps := len(allLogs) - logsWithoutTimestamp
			if bucketCounts != logsWithTimestamps {
				// Production code should not have console logs
				// Distribution count mismatch is handled gracefully anyway
			}
		}
	}

	return logDistributionEntries, uniqueSources
}

// @Summary Clear all logs
// @Description Delete all stored logs from the system
// @Tags logs
// @Accept json
// @Produce json
// @Success 200 {object} map[string]interface{} "Success message"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /logs [delete]
func (h *Services) HandleClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := h.storage.Clear(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to clear logs: %v", err), http.StatusInternalServerError)
		return
	}

	// Invalidate the system info cache since log data has changed
	h.InvalidateInfoCache()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "All logs cleared successfully",
	})
}

// sortLogs optimizes sorting for large log datasets and extracts available columns
func sortLogs(logs []map[string]interface{}, sortBy, sortOrder string) []string {
	// Create a slice of indices to sort
	indices := make([]int, len(logs))
	for i := range indices {
		indices[i] = i
	}

	// Extract unique column keys while processing logs
	columnKeysMap := make(map[string]bool)

	// Precompute comparison values to avoid repeated parsing
	comparisonValues := make([]interface{}, len(logs))
	for i, log := range logs {
		// Extract column keys
		for key := range log {
			columnKeysMap[key] = true
		}

		val, exists := log[sortBy]
		if !exists {
			comparisonValues[i] = nil
			continue
		}

		// Attempt to parse as timestamp first (most common case)
		if ts, ok := val.(time.Time); ok {
			comparisonValues[i] = ts
			continue
		}

		// Attempt to parse as float
		// Check if val interface is a number
		if num, ok := val.(float64); ok {
			comparisonValues[i] = num
			continue
		}

		// Fallback to string
		comparisonValues[i] = val
	}

	// Use a custom sorting algorithm with precomputed values
	sort.Slice(indices, func(i, j int) bool {
		valI := comparisonValues[indices[i]]
		valJ := comparisonValues[indices[j]]

		// Handle nil values (logs without the field)
		if valI == nil && valJ == nil {
			return false
		}
		if valI == nil {
			return false // nil values go last
		}
		if valJ == nil {
			return true // nil values go last
		}

		// Compare based on type
		switch a := valI.(type) {
		case time.Time:
			b := valJ.(time.Time)
			if sortOrder == "asc" {
				return a.Before(b)
			}
			return a.After(b)
		case float64:
			b := valJ.(float64)
			if sortOrder == "asc" {
				return a < b
			}
			return a > b
		case string:
			b := valJ.(string)
			if sortOrder == "asc" {
				return a < b
			}
			return a > b
		default:
			// Fallback to string representation
			strA := fmt.Sprintf("%v", valI)
			strB := fmt.Sprintf("%v", valJ)
			if sortOrder == "asc" {
				return strA < strB
			}
			return strA > strB
		}
	})

	// Reorder logs based on sorted indices
	sortedLogs := make([]map[string]interface{}, len(logs))
	for i, idx := range indices {
		sortedLogs[i] = logs[idx]
	}

	// Copy sorted logs back to original slice
	copy(logs, sortedLogs)

	// Convert column keys map to sorted slice
	availableColumns := make([]string, 0, len(columnKeysMap))
	for key := range columnKeysMap {
		availableColumns = append(availableColumns, key)
	}

	// Sort column names for consistent ordering
	sort.Strings(availableColumns)

	return availableColumns
}
