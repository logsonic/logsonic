package storage

import (
	"context"
	"fmt"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/araddon/dateparse"
	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/search/query"
)

// Search retrieves logs with optional query filtering.
//
// The query string follows Bleve's query syntax:
//
// Basic queries:
//   - Simple term: "error" (matches any field containing "error")
//   - Field scoped: "level:ERROR" (matches specific field)
//   - Exact phrase: "\"connection timeout\"" (matches exact phrase)
//
// Boolean operators:
//   - AND: "+level:ERROR +service:api" (both conditions must match)
//   - OR: "service:api OR service:auth" (either condition can match)
//   - NOT: "-level:ERROR" or "NOT level:ERROR" (negation)
//
// Range queries:
//   - Numeric: "latency:>100" (greater than), "latency:<50" (less than)
//   - Date: "timestamp:>2023-01-01" (after date)
//
// Wildcards:
//   - "mess*" (prefix), "*sage" (suffix), "m*ge" (both)
//
// Fuzzy search:
//   - "errro~" (matches misspelled words, with configurable edit distance)
//
// Complex queries can combine these features:
//   - "+level:ERROR +(service:api OR service:auth) -message:timeout"
func (s *Storage) Search(queryStr string, startDate, endDate *time.Time, sources []string) ([]map[string]interface{}, time.Duration, error) {
	// If no indices exist, return an empty list
	if len(s.indices) == 0 {
		return []map[string]interface{}{}, 0, nil
	}

	now := time.Now()

	// If no start date provided, use 1 year ago
	if startDate == nil {
		oneYearAgo := now.AddDate(-1, 0, 0)
		startDate = &oneYearAgo
	}

	// If no end date provided, use today
	if endDate == nil {
		endDate = &now
	}

	existingDates, err := s.List()
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list existing dates: %w", err)
	}

	// If no dates exist, return an empty list
	if len(existingDates) == 0 {
		return []map[string]interface{}{}, 0, nil
	}

	// Use a buffered channel for parallel processing
	type indexResult struct {
		logs []map[string]interface{}
		err  error
	}
	resultChan := make(chan indexResult, len(existingDates))

	// Create a context with cancellation to manage goroutines
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Limit concurrent goroutines to prevent overwhelming system resources
	maxConcurrency := runtime.NumCPU() * 2
	semaphore := make(chan struct{}, maxConcurrency)

	// Track dates to process
	var datesToProcess []string
	current := *startDate
	for !current.After(*endDate) {
		date := current.Format("2006-01-02")

		// Check if date exists in indices
		for _, existingDate := range existingDates {
			if existingDate == date {
				datesToProcess = append(datesToProcess, date)
				break
			}
		}

		current = current.AddDate(0, 0, 1)
	}

	// Measure time taken to process all dates
	startTime := time.Now()

	// Process indices concurrently
	var wg sync.WaitGroup
	for _, date := range datesToProcess {
		wg.Add(1)
		semaphore <- struct{}{} // Acquire semaphore slot

		go func(date string) {
			defer wg.Done()
			defer func() { <-semaphore }() // Release semaphore slot

			select {
			case <-ctx.Done():
				return
			default:
				// Prepare the search query
				var searchQuery query.Query
				if queryStr != "" {
					unescapedQueryStr, err := url.PathUnescape(queryStr)
					if err != nil {
						return
					}
					// Use Bleve's built-in query string parser
					searchQuery = bleve.NewQueryStringQuery(unescapedQueryStr)

				} else {
					searchQuery = bleve.NewMatchAllQuery()
				}

				// Add source filter if provided
				if len(sources) > 0 {
					sourceFilter := bleve.NewQueryStringQuery(strings.Join(sources, ","))
					searchQuery = bleve.NewConjunctionQuery(searchQuery, sourceFilter)
				}

				// Create the search request
				searchRequest := bleve.NewSearchRequest(searchQuery)
				searchRequest.Size = 1_000_000 // Limit per index to prevent memory explosion
				searchRequest.Fields = []string{"*"}

				// Open index safely
				index, err := s.getOrCreateIndex(date)
				if err != nil {
					resultChan <- indexResult{err: fmt.Errorf("failed to get index for date %s: %w", date, err)}
					return
				}

				searchResult, err := index.Search(searchRequest)
				if err != nil {
					resultChan <- indexResult{err: fmt.Errorf("search failed for date %s: %w", date, err)}
					return
				}

				// Convert search results to log entries
				logs := make([]map[string]interface{}, 0, len(searchResult.Hits))
				for _, hit := range searchResult.Hits {
					logEntry := make(map[string]interface{})
					var logTimestamp time.Time

					for field, value := range hit.Fields {
						if field == "timestamp" {
							parsedTime, err := dateparse.ParseAny(value.(string))
							if err != nil {
								logEntry[field] = value
							} else {
								logTimestamp = parsedTime
								logEntry[field] = parsedTime
							}
						} else if strValue, ok := value.(string); ok {
							logEntry[field] = strValue
						} else if value != nil {
							// Convert non-string values to their original type
							logEntry[field] = value
						}
					}

					// Only include logs within exact time range (including time component)
					// Check if log timestamp is within the specified time range
					if !logTimestamp.IsZero() &&
						(logTimestamp.Equal(*startDate) || logTimestamp.After(*startDate)) &&
						(logTimestamp.Equal(*endDate) || logTimestamp.Before(*endDate)) {
						logs = append(logs, logEntry)
					}
				}

				resultChan <- indexResult{logs: logs}
			}
		}(date)
	}

	// Close result channel when all goroutines are done
	go func() {
		wg.Wait()
		close(resultChan)
	}()
	totalTime := time.Since(startTime)

	// Collect results
	var results []map[string]interface{}
	var firstError error
	for result := range resultChan {
		if result.err != nil {
			// Capture first error, but continue processing
			if firstError == nil {
				firstError = result.err
			}
			continue
		}
		results = append(results, result.logs...)
	}

	// Return error if any occurred during processing
	if firstError != nil {
		return nil, 0, firstError
	}

	return results, totalTime, nil
}

// GetSourceNames returns all unique source names _src from all indices
func (s *Storage) GetSourceNames() ([]string, error) {
	sourceNames := make(map[string]bool)

	for _, index := range s.indices {
		query := bleve.NewQueryStringQuery("_src:*")
		searchRequest := bleve.NewSearchRequest(query)
		searchRequest.Fields = []string{"_src"}
		searchRequest.Size = 1000000 // Adjust this value as needed
		searchResults, err := index.Search(searchRequest)
		if err != nil {
			return nil, fmt.Errorf("failed to run search: %w", err)
		}

		for _, hit := range searchResults.Hits {
			sourceNames[hit.Fields["_src"].(string)] = true
		}
	}

	uniqueSourceNames := make([]string, 0, len(sourceNames))
	for sourceName := range sourceNames {
		uniqueSourceNames = append(uniqueSourceNames, sourceName)
	}

	return uniqueSourceNames, nil
}
