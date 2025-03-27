package tokenizer

import (
	"fmt"
	"logsonic/pkg/types"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/araddon/dateparse"
	"github.com/elastic/go-grok"
)

// Common regex patterns for smart decoder
var (
	ipv4Regex    = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	emailRegex   = regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`)
	urlRegex     = regexp.MustCompile(`https?://[^\s]+`)
	macAddrRegex = regexp.MustCompile(`([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})`)
	uuidRegex    = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
)

// SmartDecodeLog extracts common patterns from a log line
func SmartDecodeLog(logLine string) map[string][]string {
	result := make(map[string][]string)

	// Extract IPv4 addresses
	ipv4Matches := ipv4Regex.FindAllString(logLine, -1)
	if len(ipv4Matches) > 0 {
		// get the first match
		result["ipv4_addr"] = ipv4Matches
	}

	// Extract email addresses
	emailMatches := emailRegex.FindAllString(logLine, -1)
	if len(emailMatches) > 0 {
		result["email_addr"] = emailMatches
	}

	// Extract URLs
	urlMatches := urlRegex.FindAllString(logLine, -1)
	if len(urlMatches) > 0 {
		result["urls"] = urlMatches
	}

	// Extract MAC addresses
	macMatches := macAddrRegex.FindAllString(logLine, -1)
	if len(macMatches) > 0 {
		result["mac_addr"] = macMatches
	}

	// Extract UUIDs
	uuidMatches := uuidRegex.FindAllString(logLine, -1)
	if len(uuidMatches) > 0 {
		result["uuids"] = uuidMatches
	}

	return result
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

// Tokenizer interface for mocking in tests
type TokenizerInterface interface {
	ParseLogs(logLines []string, ingestSessionOptions types.IngestSessionOptions) ([]map[string]interface{}, int, int, error)
	AddPattern(pattern string, priority ...int) error
	AddCustomPattern(name, pattern string) error
	AddPersistentPattern(pattern string) error
	AddPersistentCustomPattern(name, pattern string) error
	ClearRequestPatterns()
	GetPersistentPatterns() []string
	GetCustomPatterns() map[string]string
	GetPatterns() []string
	ClearPatterns() error
}

// Tokenizer is responsible for parsing and tokenizing logs
type Tokenizer struct {
	patterns                 []string
	customPatterns           map[string]string
	patternPriorities        map[string]int
	preparedPatterns         []string
	preparedTokenizer        *grok.Grok
	persistentPatterns       []string
	persistentCustomPatterns map[string]string
	mutex                    sync.RWMutex // Add mutex for thread safety
}

// NewTokenizer creates a new instance of Tokenizer
func NewTokenizer() (*Tokenizer, error) {
	return &Tokenizer{
		patterns:                 []string{},
		customPatterns:           make(map[string]string),
		patternPriorities:        make(map[string]int),
		persistentPatterns:       []string{},
		persistentCustomPatterns: make(map[string]string),
	}, nil
}

// preparePatterns compiles the currently loaded patterns into a grok instance
func (t *Tokenizer) preparePatterns() error {
	// Create a local copy of patterns and customPatterns to work with
	var patterns []string
	var patternPriorities map[string]int
	var customPatterns map[string]string

	t.mutex.Lock()
	// Check if there are patterns to prepare
	if len(t.patterns) == 0 {
		t.mutex.Unlock()
		return fmt.Errorf("no patterns available")
	}

	// Make copies of the data we need
	patterns = make([]string, len(t.patterns))
	copy(patterns, t.patterns)

	patternPriorities = make(map[string]int, len(t.patternPriorities))
	for k, v := range t.patternPriorities {
		patternPriorities[k] = v
	}

	customPatterns = make(map[string]string, len(t.customPatterns))
	for k, v := range t.customPatterns {
		customPatterns[k] = v
	}
	t.mutex.Unlock()

	// Create a new grok instance
	g := grok.New()

	// Add all custom patterns
	for name, pattern := range customPatterns {
		if err := g.AddPattern(name, pattern); err != nil {
			return fmt.Errorf("failed to add custom pattern '%s': %w", name, err)
		}
	}

	// Sort patterns by priority (highest first)
	sort.Slice(patterns, func(i, j int) bool {
		return patternPriorities[patterns[i]] > patternPriorities[patterns[j]]
	})

	// Compile patterns
	preparedPatterns := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		if err := g.Compile(pattern, true); err != nil {
			// In production, we don't want to log warnings - just return the error
			return fmt.Errorf("failed to compile pattern '%s': %w", pattern, err)
		}
		preparedPatterns = append(preparedPatterns, pattern)
	}

	// If no patterns compiled successfully, return an error
	if len(preparedPatterns) == 0 {
		return fmt.Errorf("failed to compile any patterns")
	}

	// Update prepared patterns with write lock
	t.mutex.Lock()
	t.preparedPatterns = preparedPatterns
	t.preparedTokenizer = g
	t.mutex.Unlock()

	return nil
}

// Use dateparse library to parse the timestamp
func updateTimestamp(timestamp string, options types.IngestSessionOptions) time.Time {

	if timestamp == "" {
		return time.Now()
	}

	parsedTime, err := dateparse.ParseAny(timestamp)
	if err != nil {
		// DateParse fails to parse Android timestamp like 03-17 16:16:08.538
		// If parsing fails, try parsing Android timestamp format
		androidLayout := "01-02 15:04:05.000"
		androidTime, androidErr := time.Parse(androidLayout, timestamp)

		if androidErr == nil {
			// Successfully parsed Android format, set current year

			parsedTime = time.Date(
				time.Now().Year(),
				androidTime.Month(),
				androidTime.Day(),
				androidTime.Hour(),
				androidTime.Minute(),
				androidTime.Second(),
				androidTime.Nanosecond(),
				androidTime.Location(),
			)
		} else {
			// If all parsing attempts fail, return current time as fallback
			return time.Now()
		}
	}

	// If the year is missing, set it to the current year
	if parsedTime.Year() == 0 {
		parsedTime = parsedTime.AddDate(time.Now().Year(), 0, 0)
		if parsedTime.After(time.Now()) {
			parsedTime = parsedTime.AddDate(-1, 0, 0)
		}
	}

	// Apply forced date components if specified
	if options.ForceStartYear != "" {

		if year, err := strconv.Atoi(options.ForceStartYear); err == nil {
			parsedTime = time.Date(
				year,
				parsedTime.Month(),
				parsedTime.Day(),
				parsedTime.Hour(),
				parsedTime.Minute(),
				parsedTime.Second(),
				parsedTime.Nanosecond(),
				parsedTime.Location(),
			)
		}
	}

	if options.ForceStartMonth != "" {
		if month, err := strconv.Atoi(options.ForceStartMonth); err == nil && month >= 1 && month <= 12 {
			parsedTime = time.Date(
				parsedTime.Year(),
				time.Month(month),
				parsedTime.Day(),
				parsedTime.Hour(),
				parsedTime.Minute(),
				parsedTime.Second(),
				parsedTime.Nanosecond(),
				parsedTime.Location(),
			)
		}
	}

	if options.ForceStartDay != "" {
		if day, err := strconv.Atoi(options.ForceStartDay); err == nil && day >= 1 && day <= 31 {
			parsedTime = time.Date(
				parsedTime.Year(),
				parsedTime.Month(),
				day,
				parsedTime.Hour(),
				parsedTime.Minute(),
				parsedTime.Second(),
				parsedTime.Nanosecond(),
				parsedTime.Location(),
			)
		}
	}

	// Apply timezone if specified
	if options.ForceTimezone != "" {
		loc, err := time.LoadLocation(options.ForceTimezone)
		if err == nil {

			parsedTime = parsedTime.In(loc)
		}
	}

	// Return the timestamp as Unix milliseconds
	return parsedTime
}

// ParseLogs parses the given log lines and returns the tokenized logs as JSON
func (t *Tokenizer) ParseLogs(logLines []string, ingestSessionOptions types.IngestSessionOptions) ([]map[string]interface{}, int, int, error) {
	// Check if smart decoder is enabled
	useSmartDecoder := false
	if ingestSessionOptions.SmartDecoder {
		useSmartDecoder = true
	}

	// First check if we need to prepare patterns
	needPrepare := false

	t.mutex.RLock()
	if t.preparedPatterns == nil || t.preparedTokenizer == nil {
		needPrepare = true
	}

	// If patterns need preparation, do it before proceeding
	if needPrepare {
		if err := t.preparePatterns(); err != nil {
			return nil, 0, len(logLines), fmt.Errorf("failed to prepare patterns: %w", err)
		}
	}

	defer t.mutex.RUnlock()

	// Create a slice of maps with string keys and interface{} values
	parsedLogs := []map[string]interface{}{}
	successCount := 0
	failedCount := 0

	// If no patterns are available, mark all logs as failed
	if len(t.patterns) == 0 {
		for _, logLine := range logLines {
			failedLog := map[string]interface{}{
				"error":     "No patterns available for parsing",
				"message":   logLine,
				"timestamp": time.Now(),
			}

			// Add metadata fields
			if ingestSessionOptions.Meta != nil {
				for key, value := range ingestSessionOptions.Meta {
					failedLog[key] = value
				}
			}

			parsedLogs = append(parsedLogs, failedLog)
			failedCount++
		}

		return parsedLogs, successCount, failedCount, nil
	}

	// Safe guard for nil tokenizer
	if t.preparedTokenizer == nil {
		for _, logLine := range logLines {
			failedLog := map[string]interface{}{
				"error":     "Tokenizer not initialized properly",
				"message":   logLine,
				"timestamp": time.Now(),
			}

			// Add metadata fields
			if ingestSessionOptions.Meta != nil {
				for key, value := range ingestSessionOptions.Meta {
					failedLog[key] = value
				}
			}

			parsedLogs = append(parsedLogs, failedLog)
			failedCount++
		}
		return parsedLogs, successCount, failedCount, nil
	}

	for _, logLine := range logLines {
		var matched bool = false
		for _, _ = range t.preparedPatterns {
			parsed, err := t.preparedTokenizer.ParseString(logLine)
			if err == nil && len(parsed) > 0 {
				// Convert map[string]string to map[string]interface{}
				parsedInterface := make(map[string]interface{})
				for k, v := range parsed {
					parsedInterface[k] = v
				}

				parsedInterface["_raw"] = logLine
				parsedInterface["_src"] = ingestSessionOptions.Source

				// Add metadata fields if provided
				if ingestSessionOptions.Meta != nil {
					for key, value := range ingestSessionOptions.Meta {
						parsedInterface[key] = value
					}
				}

				// Convert timestamp string to time.Time
				if tsStr, ok := parsed["timestamp"]; ok {
					ts := updateTimestamp(tsStr, ingestSessionOptions)
					parsedInterface["timestamp"] = ts
				} else {
					parsedInterface["timestamp"] = time.Now()
				}

				// Apply smart decoder if enabled
				if useSmartDecoder {
					smartDecoderResults := SmartDecodeLog(logLine)
					for key, values := range smartDecoderResults {
						// Join values with comma instead of using fmt.Sprintf to avoid brackets
						parsedInterface["_"+key] = strings.Join(values, ", ")
					}
				}

				parsedLogs = append(parsedLogs, parsedInterface)
				matched = true
				successCount++
				break // Stop after first successful match (highest priority)
			}
		}
		if !matched {
			failedCount++
			failedLog := map[string]interface{}{
				"error":     "No grok pattern matches given log line",
				"_raw":      logLine,
				"timestamp": time.Now(),
			}

			// Add metadata fields to failed logs too
			if ingestSessionOptions.Meta != nil {
				for key, value := range ingestSessionOptions.Meta {
					failedLog[key] = value
				}
			}

			parsedLogs = append(parsedLogs, failedLog)
		}
	}

	return parsedLogs, successCount, failedCount, nil
}

// AddPattern adds a pattern for tokenizing logs
func (t *Tokenizer) AddPattern(pattern string, priority ...int) error {
	t.mutex.Lock()

	// Default priority is 0
	pri := 0
	if len(priority) > 0 {
		pri = priority[0]
	}

	// Add the pattern to the list
	t.patterns = append(t.patterns, pattern)
	t.patternPriorities[pattern] = pri

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil

	// Release the lock before preparing patterns to avoid recursive lock
	t.mutex.Unlock()

	// Prepare patterns outside the lock
	return t.preparePatterns()
}

// AddCustomPattern adds a custom named pattern
func (t *Tokenizer) AddCustomPattern(name, pattern string) error {
	// Verify the pattern is valid
	g := grok.New()
	if err := g.AddPattern(name, pattern); err != nil {
		return fmt.Errorf("invalid pattern definition: %w", err)
	}

	t.mutex.Lock()
	defer t.mutex.Unlock()

	t.customPatterns[name] = pattern

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil

	// Don't prepare patterns here - let the caller decide when to prepare
	return nil
}

// ClearPatterns clears all patterns from the tokenizer
func (t *Tokenizer) ClearPatterns() error {
	t.mutex.Lock()
	defer t.mutex.Unlock()

	// Clear patterns, custom patterns, and pattern priorities
	t.patterns = []string{}
	t.customPatterns = make(map[string]string)
	t.patternPriorities = map[string]int{}

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil

	// No need to prepare patterns as none exist
	return nil
}

// The rest of your methods should also be synchronized with mutex
// ...

// GetPatterns returns all patterns
func (t *Tokenizer) GetPatterns() []string {
	t.mutex.RLock()
	defer t.mutex.RUnlock()

	patterns := make([]string, len(t.patterns))
	copy(patterns, t.patterns)
	return patterns
}

// GetCustomPatterns returns all custom patterns
func (t *Tokenizer) GetCustomPatterns() map[string]string {
	t.mutex.RLock()
	defer t.mutex.RUnlock()

	customPatterns := make(map[string]string)
	for k, v := range t.customPatterns {
		customPatterns[k] = v
	}
	return customPatterns
}

// AddPersistentPattern adds a pattern that persists between requests
func (t *Tokenizer) AddPersistentPattern(pattern string) error {
	t.mutex.Lock()
	defer t.mutex.Unlock()

	// Check if pattern already exists
	for _, p := range t.persistentPatterns {
		if p == pattern {
			return nil // Pattern already exists, no need to add it again
		}
	}

	// Add the pattern to the persistent patterns list
	t.persistentPatterns = append(t.persistentPatterns, pattern)

	// Also add it to the regular patterns list
	t.patterns = append(t.patterns, pattern)
	t.patternPriorities[pattern] = 100 // Give persistent patterns high priority

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil

	return nil
}

// AddPersistentCustomPattern adds a custom named pattern that persists between requests
func (t *Tokenizer) AddPersistentCustomPattern(name, pattern string) error {
	// Verify the pattern is valid
	g := grok.New()
	if err := g.AddPattern(name, pattern); err != nil {
		return fmt.Errorf("invalid persistent custom pattern definition: %w", err)
	}

	t.mutex.Lock()
	defer t.mutex.Unlock()

	// Add to persistent custom patterns
	t.persistentCustomPatterns[name] = pattern

	// Also add to regular custom patterns
	t.customPatterns[name] = pattern

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil

	return nil
}

// ClearRequestPatterns clears non-persistent patterns
func (t *Tokenizer) ClearRequestPatterns() {
	t.mutex.Lock()
	defer t.mutex.Unlock()

	// Clear non-persistent patterns
	t.patterns = make([]string, len(t.persistentPatterns))
	copy(t.patterns, t.persistentPatterns)

	// Clear non-persistent custom patterns
	t.customPatterns = make(map[string]string)
	for k, v := range t.persistentCustomPatterns {
		t.customPatterns[k] = v
	}

	// Clear pattern priorities except for persistent patterns
	newPriorities := make(map[string]int)
	for _, pattern := range t.persistentPatterns {
		if priority, exists := t.patternPriorities[pattern]; exists {
			newPriorities[pattern] = priority
		} else {
			newPriorities[pattern] = 100 // Default high priority for persistent patterns
		}
	}
	t.patternPriorities = newPriorities

	// Invalidate prepared patterns cache
	t.preparedPatterns = nil
	t.preparedTokenizer = nil
}

// GetPersistentPatterns returns all persistent patterns
func (t *Tokenizer) GetPersistentPatterns() []string {
	t.mutex.RLock()
	defer t.mutex.RUnlock()

	patterns := make([]string, len(t.persistentPatterns))
	copy(patterns, t.persistentPatterns)
	return patterns
}
