package storage

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/araddon/dateparse"
	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/mapping"
	blevesearch "github.com/blevesearch/bleve/v2/search"
	"github.com/blevesearch/bleve/v2/search/query"
)

const (
	// MaxSearchPageSize bounds response allocation even for direct storage callers.
	MaxSearchPageSize   = 1000
	searchScanBatchSize = 1000
	legacyScanBatchSize = 10000
	maxDistributionBins = 100
)

// SearchOptions contains every input needed for a bounded log page.
type SearchOptions struct {
	Query     string
	StartDate time.Time
	EndDate   time.Time
	Sources   []string
	Limit     int
	Offset    int
	SortBy    string
	SortOrder string
}

// SearchDistributionBucket is a bounded aggregation result for the chart.
type SearchDistributionBucket struct {
	StartTime    time.Time
	EndTime      time.Time
	Count        int
	SourceCounts map[string]int
}

// SearchPageResult returns only the requested rows plus bounded metadata.
type SearchPageResult struct {
	Logs             []map[string]interface{}
	TotalCount       int
	AvailableColumns []string
	Distribution     []SearchDistributionBucket
	QueryTime        time.Duration
}

// SearchPage retrieves a timestamp-sorted page without materializing every
// matching document. Existing offset callers are served by bounded
// search-after scans; cursor pagination can replace the compatibility offset
// at the HTTP boundary later without changing this storage behavior.
func (s *Storage) SearchPage(ctx context.Context, options SearchOptions) (SearchPageResult, error) {
	started := time.Now()
	result := SearchPageResult{Logs: []map[string]interface{}{}}

	if err := ctx.Err(); err != nil {
		return result, err
	}
	if options.SortBy != "timestamp" {
		return result, fmt.Errorf("bounded search does not support sort field %q", options.SortBy)
	}
	if options.SortOrder != "asc" && options.SortOrder != "desc" {
		return result, fmt.Errorf("invalid sort order %q", options.SortOrder)
	}
	if options.Limit <= 0 {
		return result, fmt.Errorf("limit must be positive")
	}
	if options.Limit > MaxSearchPageSize {
		return result, fmt.Errorf("limit must not exceed %d", MaxSearchPageSize)
	}
	if options.Offset < 0 {
		return result, fmt.Errorf("offset must be non-negative")
	}
	if options.EndDate.Before(options.StartDate) {
		return result, nil
	}

	dates, err := s.List()
	if err != nil {
		return result, fmt.Errorf("failed to list existing dates: %w", err)
	}
	selectedDates := intersectingDates(dates, options.StartDate, options.EndDate)
	if len(selectedDates) == 0 {
		result.QueryTime = time.Since(started)
		return result, nil
	}

	// Ensure every selected index is open before taking the operation lease.
	for _, date := range selectedDates {
		if _, err := s.getOrCreateIndex(date); err != nil {
			return result, fmt.Errorf("failed to get index for date %s: %w", date, err)
		}
	}

	// Keep retention/clear from closing an index between alias construction and
	// the final facet query.
	s.mu.RLock()
	defer s.mu.RUnlock()

	indexes := make([]bleve.Index, 0, len(selectedDates))
	timestampsIndexed := true
	columnSet := make(map[string]struct{})
	for _, date := range selectedDates {
		index, ok := s.indices[date]
		if !ok {
			continue
		}
		indexes = append(indexes, index)
		if !timestampIsIndexed(index) {
			timestampsIndexed = false
		}
		fields, fieldErr := index.Fields()
		if fieldErr != nil {
			return result, fmt.Errorf("failed to list fields for date %s: %w", date, fieldErr)
		}
		for _, field := range fields {
			if field != "_seq" && field != "_all" {
				columnSet[field] = struct{}{}
			}
		}
	}
	if len(indexes) == 0 {
		result.QueryTime = time.Since(started)
		return result, nil
	}
	result.AvailableColumns = make([]string, 0, len(columnSet)+1)
	columnSet["_id"] = struct{}{}
	for field := range columnSet {
		result.AvailableColumns = append(result.AvailableColumns, field)
	}
	sort.Strings(result.AvailableColumns)

	baseQuery, err := buildPageQuery(options.Query, options.Sources)
	if err != nil {
		return result, err
	}
	if timestampsIndexed {
		inclusive := true
		timeQuery := query.NewDateRangeInclusiveQuery(options.StartDate, options.EndDate, &inclusive, &inclusive)
		timeQuery.SetField("timestamp")
		baseQuery = bleve.NewConjunctionQuery(baseQuery, timeQuery)
	}
	alias := bleve.NewIndexAlias(indexes...)
	buckets, facetRequest := buildTimeFacet(options.StartDate, options.EndDate)

	remainingOffset := options.Offset
	var searchAfter []string
	var candidateTotal int
	firstRequest := true
	for len(result.Logs) < options.Limit {
		if err := ctx.Err(); err != nil {
			return SearchPageResult{}, err
		}

		request := bleve.NewSearchRequest(baseQuery)
		request.Size = options.Limit - len(result.Logs)
		if remainingOffset >= searchScanBatchSize {
			request.Size = searchScanBatchSize
		} else if remainingOffset > 0 {
			request.Size += remainingOffset
		}
		if request.Size > searchScanBatchSize {
			request.Size = searchScanBatchSize
		}
		request.Fields = []string{"*"}
		request.SortByCustom(timestampSort(options.SortOrder))
		if len(searchAfter) > 0 {
			request.SetSearchAfter(searchAfter)
		}
		if firstRequest && timestampsIndexed {
			request.AddFacet("time", facetRequest)
		}

		searchResult, searchErr := alias.SearchInContext(ctx, request)
		if searchErr != nil {
			return SearchPageResult{}, searchErr
		}
		if firstRequest {
			candidateTotal = int(searchResult.Total)
			if timestampsIndexed {
				applyFacetCounts(buckets, searchResult.Facets["time"], "")
				result.TotalCount = distributionTotal(buckets)
			}
			firstRequest = false
		}
		if len(searchResult.Hits) == 0 {
			break
		}

		for _, hit := range searchResult.Hits {
			logEntry, timestamp, ok := pageHitToLog(hit.ID, hit.Fields)
			if !ok || timestamp.Before(options.StartDate) || timestamp.After(options.EndDate) {
				continue
			}
			if remainingOffset > 0 {
				remainingOffset--
				continue
			}
			result.Logs = append(result.Logs, logEntry)
			if len(result.Logs) == options.Limit {
				break
			}
		}

		lastHit := searchResult.Hits[len(searchResult.Hits)-1]
		searchAfter = lastHit.DecodedSort
		if len(searchAfter) == 0 {
			searchAfter = lastHit.Sort
		}
		if len(searchAfter) == 0 || len(searchResult.Hits) < request.Size {
			break
		}
	}

	// The selected source is already part of the base query, so one-source
	// distributions need no second index scan. For multiple sources, bounded
	// size-zero facet requests preserve the per-source chart breakdown.
	uniqueSources := deduplicateStrings(options.Sources)
	if timestampsIndexed {
		if len(uniqueSources) == 1 {
			for i := range buckets {
				if buckets[i].Count > 0 {
					buckets[i].SourceCounts[uniqueSources[0]] = buckets[i].Count
				}
			}
		} else if len(uniqueSources) > 1 {
			for _, source := range uniqueSources {
				sourceQuery, queryErr := buildPageQuery(options.Query, []string{source})
				if queryErr != nil {
					return SearchPageResult{}, queryErr
				}
				inclusive := true
				timeQuery := query.NewDateRangeInclusiveQuery(options.StartDate, options.EndDate, &inclusive, &inclusive)
				timeQuery.SetField("timestamp")
				sourceQuery = bleve.NewConjunctionQuery(sourceQuery, timeQuery)
				_, sourceFacet := buildTimeFacet(options.StartDate, options.EndDate)
				request := bleve.NewSearchRequest(sourceQuery)
				request.Size = 0
				request.AddFacet("time", sourceFacet)
				sourceResult, sourceErr := alias.SearchInContext(ctx, request)
				if sourceErr != nil {
					return SearchPageResult{}, sourceErr
				}
				applyFacetCounts(buckets, sourceResult.Facets["time"], source)
			}
		}
	} else {
		legacyBuckets, legacyTotal, legacyErr := aggregateLegacyMetadata(
			ctx, alias, baseQuery, buckets, candidateTotal, options, uniqueSources,
			rangeCoversSelectedShards(options.StartDate, options.EndDate, selectedDates),
		)
		if legacyErr != nil {
			return SearchPageResult{}, legacyErr
		}
		buckets = legacyBuckets
		result.TotalCount = legacyTotal
	}

	result.Distribution = buckets
	result.QueryTime = time.Since(started)
	return result, nil
}

func timestampIsIndexed(index bleve.Index) bool {
	indexMapping, ok := index.Mapping().(*mapping.IndexMappingImpl)
	if !ok || indexMapping.DefaultMapping == nil {
		return false
	}
	timestampMapping, ok := indexMapping.DefaultMapping.Properties["timestamp"]
	if !ok {
		return false
	}
	for _, field := range timestampMapping.Fields {
		if field.Type == "datetime" {
			return field.Index
		}
	}
	return false
}

func aggregateLegacyMetadata(
	ctx context.Context,
	alias bleve.Index,
	baseQuery query.Query,
	buckets []SearchDistributionBucket,
	candidateTotal int,
	options SearchOptions,
	sources []string,
	coversSelectedShards bool,
) ([]SearchDistributionBucket, int, error) {
	if candidateTotal == 0 {
		return []SearchDistributionBucket{}, 0, nil
	}
	if coversSelectedShards {
		firstDay, _ := time.Parse("2006-01-02", options.StartDate.Format("2006-01-02"))
		lastDay, _ := time.Parse("2006-01-02", options.EndDate.Format("2006-01-02"))
		return legacyWholeRangeBucket(ctx, alias, options, sources, candidateTotal, firstDay, lastDay.AddDate(0, 0, 1))
	}

	minimum, minOK, err := boundaryTimestamp(ctx, alias, baseQuery, "asc")
	if err != nil {
		return nil, 0, err
	}
	maximum, maxOK, err := boundaryTimestamp(ctx, alias, baseQuery, "desc")
	if err != nil {
		return nil, 0, err
	}
	if !minOK || !maxOK {
		return []SearchDistributionBucket{}, 0, nil
	}

	// If every candidate is inside the exact range, Bleve's size-zero total is
	// already exact. This is the common whole-shard path and avoids a legacy
	// full scan while retaining a truthful single-bucket distribution.
	if !minimum.Before(options.StartDate) && !maximum.After(options.EndDate) {
		bucketEnd := maximum
		if !bucketEnd.After(minimum) {
			bucketEnd = minimum.Add(time.Second)
		}
		return legacyWholeRangeBucket(ctx, alias, options, sources, candidateTotal, minimum, bucketEnd)
	}

	for i := range buckets {
		buckets[i].Count = 0
		buckets[i].SourceCounts = make(map[string]int)
	}
	total, err := scanLegacyMetadata(ctx, alias, baseQuery, buckets, options.StartDate, options.EndDate)
	return buckets, total, err
}

func legacyWholeRangeBucket(
	ctx context.Context,
	alias bleve.Index,
	options SearchOptions,
	sources []string,
	total int,
	start time.Time,
	end time.Time,
) ([]SearchDistributionBucket, int, error) {
	bucket := SearchDistributionBucket{
		StartTime:    start,
		EndTime:      end,
		Count:        total,
		SourceCounts: make(map[string]int),
	}
	if len(sources) == 1 {
		bucket.SourceCounts[sources[0]] = total
	} else {
		for _, source := range sources {
			sourceQuery, err := buildPageQuery(options.Query, []string{source})
			if err != nil {
				return nil, 0, err
			}
			request := bleve.NewSearchRequest(sourceQuery)
			request.Size = 0
			result, err := alias.SearchInContext(ctx, request)
			if err != nil {
				return nil, 0, err
			}
			if result.Total > 0 {
				bucket.SourceCounts[source] = int(result.Total)
			}
		}
	}
	return []SearchDistributionBucket{bucket}, total, nil
}

func rangeCoversSelectedShards(start, end time.Time, dates []string) bool {
	if len(dates) == 0 {
		return false
	}
	firstDay, err := time.Parse("2006-01-02", dates[0])
	if err != nil {
		return false
	}
	lastDay, err := time.Parse("2006-01-02", dates[len(dates)-1])
	if err != nil {
		return false
	}
	lastCoveredInstant := lastDay.Add(24*time.Hour - time.Nanosecond)
	return !start.After(firstDay) && !end.Before(lastCoveredInstant)
}

func boundaryTimestamp(ctx context.Context, alias bleve.Index, searchQuery query.Query, order string) (time.Time, bool, error) {
	request := bleve.NewSearchRequest(searchQuery)
	request.Size = 1
	request.Fields = []string{"timestamp"}
	request.SortByCustom(timestampSort(order))
	result, err := alias.SearchInContext(ctx, request)
	if err != nil {
		return time.Time{}, false, err
	}
	if len(result.Hits) == 0 {
		return time.Time{}, false, nil
	}
	value, ok := result.Hits[0].Fields["timestamp"].(string)
	if !ok {
		return time.Time{}, false, nil
	}
	parsed, err := dateparse.ParseAny(value)
	if err != nil {
		return time.Time{}, false, nil
	}
	return parsed, true, nil
}

func scanLegacyMetadata(
	ctx context.Context,
	alias bleve.Index,
	searchQuery query.Query,
	buckets []SearchDistributionBucket,
	start time.Time,
	end time.Time,
) (int, error) {
	var searchAfter []string
	total := 0
	for {
		request := bleve.NewSearchRequest(searchQuery)
		request.Size = legacyScanBatchSize
		request.Fields = []string{"timestamp", "_src"}
		request.SortByCustom(timestampSort("asc"))
		if len(searchAfter) > 0 {
			request.SetSearchAfter(searchAfter)
		}
		result, err := alias.SearchInContext(ctx, request)
		if err != nil {
			return 0, err
		}
		if len(result.Hits) == 0 {
			break
		}
		pastEnd := false
		for _, hit := range result.Hits {
			value, ok := hit.Fields["timestamp"].(string)
			if !ok {
				continue
			}
			timestamp, parseErr := dateparse.ParseAny(value)
			if parseErr != nil || timestamp.Before(start) {
				continue
			}
			if timestamp.After(end) {
				pastEnd = true
				break
			}
			index := distributionBucketIndex(buckets, timestamp)
			if index < 0 {
				continue
			}
			buckets[index].Count++
			total++
			if source, ok := hit.Fields["_src"].(string); ok && source != "" {
				buckets[index].SourceCounts[source]++
			}
		}
		if pastEnd || len(result.Hits) < request.Size {
			break
		}
		lastHit := result.Hits[len(result.Hits)-1]
		searchAfter = lastHit.DecodedSort
		if len(searchAfter) == 0 {
			searchAfter = lastHit.Sort
		}
		if len(searchAfter) == 0 {
			break
		}
	}
	return total, nil
}

func distributionBucketIndex(buckets []SearchDistributionBucket, timestamp time.Time) int {
	if len(buckets) == 0 || timestamp.Before(buckets[0].StartTime) || timestamp.After(buckets[len(buckets)-1].EndTime) {
		return -1
	}
	if timestamp.Equal(buckets[len(buckets)-1].EndTime) {
		return len(buckets) - 1
	}
	totalDuration := buckets[len(buckets)-1].EndTime.Sub(buckets[0].StartTime)
	if totalDuration <= 0 {
		return 0
	}
	index := int(float64(timestamp.Sub(buckets[0].StartTime)) / float64(totalDuration) * float64(len(buckets)))
	if index < 0 {
		return -1
	}
	if index >= len(buckets) {
		return len(buckets) - 1
	}
	return index
}

func intersectingDates(existing []string, start, end time.Time) []string {
	selected := make([]string, 0, len(existing))
	startDay := start.Format("2006-01-02")
	endDay := end.Format("2006-01-02")
	for _, date := range existing {
		if date >= startDay && date <= endDay {
			selected = append(selected, date)
		}
	}
	sort.Strings(selected)
	return selected
}

func buildPageQuery(queryStr string, sources []string) (query.Query, error) {
	var searchQuery query.Query
	if queryStr == "" {
		searchQuery = bleve.NewMatchAllQuery()
	} else {
		unescaped, err := url.PathUnescape(queryStr)
		if err != nil {
			return nil, fmt.Errorf("invalid query encoding: %w", err)
		}
		parsed, err := bleve.NewQueryStringQuery(unescaped).Parse()
		if err != nil {
			return nil, fmt.Errorf("invalid query: %w", err)
		}
		searchQuery = optimizeQuery(parsed)
	}

	if len(sources) == 0 {
		return searchQuery, nil
	}
	sourceQueries := make([]query.Query, 0, len(sources))
	for _, source := range sources {
		sourceQueries = append(sourceQueries, &storedPhraseQuery{
			phrase: source,
			field:  "_src",
			boost:  1,
		})
	}
	return bleve.NewConjunctionQuery(searchQuery, bleve.NewDisjunctionQuery(sourceQueries...)), nil
}

func timestampSort(order string) blevesearch.SortOrder {
	descending := order == "desc"
	return blevesearch.SortOrder{
		&blevesearch.SortField{Field: "timestamp", Type: blevesearch.SortFieldAsDate, Desc: descending},
		&blevesearch.SortField{Field: "_seq", Type: blevesearch.SortFieldAsNumber, Desc: descending},
		&blevesearch.SortDocID{Desc: descending},
	}
}

func pageHitToLog(id string, fields map[string]interface{}) (map[string]interface{}, time.Time, bool) {
	entry := make(map[string]interface{}, len(fields))
	entry["_id"] = id
	var timestamp time.Time
	for field, value := range fields {
		if field == "_seq" {
			continue
		}
		if field == "timestamp" {
			valueString, ok := value.(string)
			if !ok {
				return nil, time.Time{}, false
			}
			parsed, err := dateparse.ParseAny(valueString)
			if err != nil {
				return nil, time.Time{}, false
			}
			timestamp = parsed
			entry[field] = parsed
			continue
		}
		if value != nil {
			entry[field] = value
		}
	}
	return entry, timestamp, !timestamp.IsZero()
}

func buildTimeFacet(start, end time.Time) ([]SearchDistributionBucket, *bleve.FacetRequest) {
	endExclusive := end.Add(time.Nanosecond)
	duration := endExclusive.Sub(start)
	bucketCount := maxDistributionBins
	if duration <= 0 {
		bucketCount = 1
	} else if seconds := int((duration + time.Second - 1) / time.Second); seconds < bucketCount {
		bucketCount = seconds
	}
	if bucketCount < 1 {
		bucketCount = 1
	}

	buckets := make([]SearchDistributionBucket, bucketCount)
	facetRequest := bleve.NewFacetRequest("timestamp", bucketCount)
	for i := 0; i < bucketCount; i++ {
		bucketStart := start.Add(time.Duration(i) * duration / time.Duration(bucketCount))
		bucketEnd := start.Add(time.Duration(i+1) * duration / time.Duration(bucketCount))
		if i == bucketCount-1 {
			bucketEnd = endExclusive
		}
		name := fmt.Sprintf("bucket-%03d", i)
		facetRequest.AddDateTimeRange(name, bucketStart, bucketEnd)
		buckets[i] = SearchDistributionBucket{
			StartTime:    bucketStart,
			EndTime:      bucketEnd,
			SourceCounts: make(map[string]int),
		}
	}
	return buckets, facetRequest
}

func applyFacetCounts(buckets []SearchDistributionBucket, facet *blevesearch.FacetResult, source string) {
	if facet == nil {
		return
	}
	for _, dateRange := range facet.DateRanges {
		var index int
		if _, err := fmt.Sscanf(dateRange.Name, "bucket-%03d", &index); err != nil || index < 0 || index >= len(buckets) {
			continue
		}
		if source == "" {
			buckets[index].Count = dateRange.Count
		} else if dateRange.Count > 0 {
			buckets[index].SourceCounts[source] = dateRange.Count
		}
	}
}

func distributionTotal(buckets []SearchDistributionBucket) int {
	total := 0
	for _, bucket := range buckets {
		total += bucket.Count
	}
	return total
}

func deduplicateStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
