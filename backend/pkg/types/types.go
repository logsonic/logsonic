// Package types contains shared type definitions used across packages
package types

import (
	"time"

	"logsonic/pkg/timeresolve"
)

// IngestSessionOptions defines options for log ingestion
type IngestSessionOptions struct {
	Name            string            `json:"name,omitempty"`
	Priority        int               `json:"priority,omitempty"`
	CustomPatterns  map[string]string `json:"custom_patterns,omitempty"`
	Pattern         string            `json:"pattern,omitempty"`
	Source          string            `json:"source,omitempty"`
	SmartDecoder    bool              `json:"smart_decoder,omitempty"`
	ForceTimezone   string            `json:"force_timezone,omitempty"`
	ForceStartYear  string            `json:"force_start_year,omitempty"`
	ForceStartMonth string            `json:"force_start_month,omitempty"`
	ForceStartDay   string            `json:"force_start_day,omitempty"`
	// SourceMTime is the modification time of the source file when
	// known. Lets the resolver anchor year-less or 2-digit-year
	// timestamps against the file rather than wall-clock now.
	SourceMTime *time.Time `json:"source_mtime,omitempty"`
	// TimestampConfig is the user-confirmed resolution from the import
	// wizard. When nil, the resolver auto-derives defaults from a
	// sample (legacy ForceStart* fields are still honoured).
	TimestampConfig *timeresolve.Resolution `json:"timestamp_config,omitempty"`
	// Meta contains additional fields to be added to each log entry
	// These fields will be directly added to the JSON output for each log
	// Example: for CloudWatch logs: {"aws_region": "us-west-2", "log_group": "my-group", "log_stream": "stream-1"}
	Meta map[string]interface{} `json:"meta,omitempty"`
}

// GrokPatternDefinition represents a comprehensive Grok pattern definition
type GrokPatternDefinition struct {
	Name           string            `json:"name"`
	Pattern        string            `json:"pattern"`
	Priority       int               `json:"priority,omitempty"`
	Description    string            `json:"description,omitempty"`
	Type           string            `json:"type,omitempty"` // e.g., "standard", "custom"
	CustomPatterns map[string]string `json:"custom_patterns,omitempty"`
}

// IngestRequest represents the structure of the ingest API request
type IngestRequest struct {
	Logs      []string `json:"logs"`
	SessionID string   `json:"session_id,omitempty"`
}

// IngestRequest represents the structure of the ingest API request
type ParseRequest struct {
	Logs                 []string             `json:"logs"`
	GrokPattern          string               `json:"grok_pattern,omitempty"`
	CustomPatterns       map[string]string    `json:"custom_patterns,omitempty"`
	IngestSessionOptions IngestSessionOptions `json:"session_options,omitempty"`
}

// IngestFileRequest represents the structure of the file-based ingest API request
type IngestFileRequest struct {
	LogFileName string `json:"log_file_name"`
	SessionID   string `json:"session_id,omitempty"`
}

type IngestResponse struct {
	Status    string `json:"status"`
	Filename  string `json:"filename,omitempty"`
	Error     string `json:"error,omitempty"`
	Processed int    `json:"processed"`
	Failed    int    `json:"failed"`
	SessionID string `json:"session_id,omitempty"`
}

// ParseResponse represents the response from the parse endpoint
// @Description Response from the parse endpoint, containing parsed logs and potential error information
type ParseResponse struct {
	// Status of the parse operation
	// @Example "success" or "error"
	Status string `json:"status"`

	// Number of log lines processed
	Processed int `json:"processed"`

	// Number of log lines that failed to parse
	Failed int `json:"failed"`

	// Pattern used for parsing (optional)
	Pattern string `json:"pattern,omitempty"`

	// Description of the pattern (optional)
	PatternDescription string `json:"pattern_description,omitempty"`

	// Custom patterns used (optional)
	CustomPatterns map[string]string `json:"custom_patterns,omitempty"`

	// Array of parsed log entries, where each entry is a key-value map
	Logs []map[string]interface{} `json:"logs"`

	// TimestampInference describes how the resolver interpreted the
	// timestamps in this sample. Drives the wizard's diagnostic chip
	// and live preview. Empty when no logs were provided.
	TimestampInference *timeresolve.Inference `json:"timestamp_inference,omitempty"`
}

// ErrorResponse represents a standardized error response
// @Description Standardized error response structure used across all API endpoints
type ErrorResponse struct {
	// Status will always be "error" for error responses
	Status string `json:"status"`
	// Main error message
	Error string `json:"error"`
	// Error code for programmatic handling
	Code string `json:"code,omitempty"`
	// Additional error details
	Details string `json:"details,omitempty"`
}

// SystemInfoResponse contains detailed information about the system and storage
type SystemInfoResponse struct {
	Status      string `json:"status"`
	StorageInfo struct {
		TotalIndices     int      `json:"total_indices"`
		AvailableDates   []string `json:"available_dates"`
		TotalLogEntries  int      `json:"total_log_entries"`
		StorageDirectory string   `json:"storage_directory"`
		StorageSize      int64    `json:"storage_size_bytes"`
		SourceNames      []string `json:"source_names"`
	} `json:"storage_info"`
	SystemInfo struct {
		Hostname     string `json:"hostname"`
		OSType       string `json:"os_type"`
		Architecture string `json:"architecture"`
		GoVersion    string `json:"go_version"`
		NumCPU       int    `json:"num_cpu"`
		MemoryUsage  struct {
			Alloc      uint64 `json:"alloc_bytes"`
			TotalAlloc uint64 `json:"total_alloc_bytes"`
			Sys        uint64 `json:"sys_bytes"`
			NumGC      uint32 `json:"num_gc"`
		} `json:"memory_usage"`
	} `json:"system_info"`
}

// GrokPatternRequest represents the structure for managing Grok patterns
// @Description Request structure for creating or updating Grok patterns
type GrokPatternRequest struct {
	// Name of the Grok pattern
	Name string `json:"name,omitempty"`
	// Priority of the pattern (higher numbers are matched first)
	Priority int `json:"priority,omitempty"`
	// Map of custom pattern definitions used by this pattern
	CustomPatterns map[string]string `json:"custom_patterns,omitempty"`
	// The Grok pattern string
	Pattern string `json:"pattern,omitempty"`
	// Human-readable description of the pattern
	Description string `json:"description,omitempty"`
	// TimestampConfig is the user's preferred resolution for this
	// pattern. Persisted in a logsonic-side file (log2grok's library
	// schema doesn't carry it) and re-applied on subsequent imports.
	TimestampConfig *timeresolve.Resolution `json:"timestamp_config,omitempty"`
}

// GrokPatternResponse represents the response for Grok pattern operations
// @Description Response structure for Grok pattern operations
type GrokPatternResponse struct {
	// Status of the operation
	Status string `json:"status"`
	// List of Grok patterns
	Patterns []GrokPatternRequest `json:"patterns,omitempty"`
	// Error message if status is "error"
	Error string `json:"error,omitempty"`
}

// LogDistributionEntry represents a single time bucket in log distribution
type LogDistributionEntry struct {
	StartTime    string         `json:"start_time"`
	EndTime      string         `json:"end_time"`
	Count        int            `json:"count"`
	SourceCounts map[string]int `json:"source_counts"`
}

// LogResponse represents the response for log retrieval with distribution
type LogResponse struct {
	Status           string                   `json:"status"`
	TotalCount       int                      `json:"total_count"`
	Offset           int                      `json:"offset"`
	Limit            int                      `json:"limit"`
	TimeTaken        int                      `json:"time_taken"`
	IndexQueryTime   int                      `json:"index_query_time"`
	Count            int                      `json:"count"`
	Logs             []map[string]interface{} `json:"logs"`
	SortBy           string                   `json:"sort_by"`
	SortOrder        string                   `json:"sort_order"`
	Query            string                   `json:"query"`
	StartDate        string                   `json:"start_date"`
	EndDate          string                   `json:"end_date"`
	AvailableColumns []string                 `json:"available_columns"`
	LogDistribution  []LogDistributionEntry   `json:"log_distribution"`
}

// AutosuggestResult represents the result of pattern matching
type AutosuggestResult struct {
	PatternName        string                   `json:"pattern_name"`
	PatternDescription string                   `json:"pattern_description"`
	Pattern            string                   `json:"pattern"`
	Score              float64                  `json:"score"`
	// Coverage is the fraction of input lines matched by this pattern (0.0–1.0).
	// Heterogeneous streams will show multiple patterns each covering a subset.
	Coverage           float64                  `json:"coverage"`
	ParsedLogs         []map[string]interface{} `json:"parsed_logs"`
	CustomPatterns     map[string]string        `json:"custom_patterns,omitempty"`
	// TimestampField / TimestampLayout / TimestampSource carry log2grok's
	// auto-derived timestamp hint when one was inferred from the chosen
	// Grok body (HTTPDATE → "timestamp" + Go layout, TIMESTAMP_ISO8601 →
	// "ts" + ISO layout, etc.). The frontend uses them to pre-select the
	// timestamp column in step 3 of the import wizard without a second
	// /parse round-trip. Empty when log2grok could not infer one.
	TimestampField  string `json:"timestamp_field,omitempty"`
	TimestampLayout string `json:"timestamp_layout,omitempty"`
	TimestampSource string `json:"timestamp_source,omitempty"`
}

// SuggestResponse represents the response from the suggest endpoint
type SuggestResponse struct {
	Status  string              `json:"status"`
	Type    string              `json:"type"`
	Results []AutosuggestResult `json:"results"`
}

// LogDistributionResponse represents the response for log distribution retrieval
// Deprecated: This type is no longer used as distribution data is now included in LogResponse
type LogDistributionResponse struct {
	Status          string                 `json:"status"`
	TotalCount      int                    `json:"total_count"`
	Query           string                 `json:"query"`
	StartDate       string                 `json:"start_date"`
	EndDate         string                 `json:"end_date"`
	LogDistribution []LogDistributionEntry `json:"log_distribution"`
}
