package storage

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"logsonic/pkg/types"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/search/query"
)

// Facet limits. See specs/now-02-faceted-fields-sidebar.md, "Design decisions".
const (
	// MaxFacetFields caps the number of fields in a response (sorted by name).
	MaxFacetFields = 50
	// MaxFacetValues caps the values returned per field (UI shows 5, "show
	// more" reveals the rest).
	MaxFacetValues = 8
	// MaxFacetValueLen truncates long values so a stack trace stored in a
	// field cannot bloat the response.
	MaxFacetValueLen = 120
	// MaxFacetSampleRows bounds the scan. The spec's original decision
	// ("aggregate over the hits the search already returns") predates the
	// bounded SearchPage path, which hands the handler at most one page of
	// rows -- faceting a page would make counts change as the user pages.
	// A bounded scan of the newest rows in the window, reported through
	// FacetsResponse.ComputedOver/Sampled, is the honest equivalent: opt-in
	// per request, capped, and explicit about what it covered.
	MaxFacetSampleRows = 20_000
	facetScanBatchSize = 1000
	// highCardinalityRatio marks a field as high-cardinality (IDs, request
	// numbers) when it has more distinct values than this share of the rows
	// aggregated -- but only once at least highCardinalityMinRows rows were
	// seen, otherwise every field on a 1-row result would be "high
	// cardinality" and the panel would be empty.
	highCardinalityRatio   = 0.5
	highCardinalityMinRows = 20
)

// facetAggregator accumulates field -> value -> count over rows fed one at a
// time, so a scan never has to materialize the sampled rows.
type facetAggregator struct {
	rows   int
	counts map[string]map[string]int
}

func newFacetAggregator() *facetAggregator {
	return &facetAggregator{counts: make(map[string]map[string]int)}
}

// Add folds one row in. Internal fields (leading underscore) are skipped
// except _src; timestamp is skipped entirely (its facet would be the row
// count). Values that cannot be rendered as a single scalar (nested JSON
// objects/arrays, nil) are skipped rather than stringified into noise.
func (a *facetAggregator) Add(row map[string]interface{}) {
	a.rows++
	for field, raw := range row {
		if field == "timestamp" || (strings.HasPrefix(field, "_") && field != "_src") {
			continue
		}
		value, ok := facetValueString(raw)
		if !ok {
			continue
		}
		values, exists := a.counts[field]
		if !exists {
			values = make(map[string]int)
			a.counts[field] = values
		}
		values[value]++
	}
}

// facetValueString renders a stored value deterministically. Numeric-looking
// strings are stored as int64/float64 by StoreWithIDs and come back from
// Bleve as float64, so 200 and 200.0 must render identically ('f', -1).
func facetValueString(raw interface{}) (string, bool) {
	switch v := raw.(type) {
	case string:
		return v, true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case float32:
		return strconv.FormatFloat(float64(v), 'f', -1, 32), true
	case int:
		return strconv.Itoa(v), true
	case int64:
		return strconv.FormatInt(v, 10), true
	case int32:
		return strconv.FormatInt(int64(v), 10), true
	case uint64:
		return strconv.FormatUint(v, 10), true
	case bool:
		return strconv.FormatBool(v), true
	default:
		return "", false
	}
}

// Result renders the aggregate with the response caps applied. Fields sort by
// name, values by count desc then value asc, so the output is deterministic.
func (a *facetAggregator) Result() *types.FacetsResponse {
	out := &types.FacetsResponse{ComputedOver: a.rows, Fields: []types.FacetField{}}
	names := make([]string, 0, len(a.counts))
	for name := range a.counts {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > MaxFacetFields {
		names = names[:MaxFacetFields]
	}
	for _, name := range names {
		values := a.counts[name]
		field := types.FacetField{Name: name, Distinct: len(values), Values: []types.FacetValue{}}
		if a.rows >= highCardinalityMinRows && float64(len(values)) > highCardinalityRatio*float64(a.rows) {
			field.HighCardinality = true
			out.Fields = append(out.Fields, field)
			continue
		}
		list := make([]types.FacetValue, 0, len(values))
		for value, count := range values {
			list = append(list, types.FacetValue{Value: value, Count: count})
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].Count != list[j].Count {
				return list[i].Count > list[j].Count
			}
			return list[i].Value < list[j].Value
		})
		if len(list) > MaxFacetValues {
			list = list[:MaxFacetValues]
		}
		for i := range list {
			list[i].Value, list[i].Truncated = truncateFacetValue(list[i].Value)
		}
		field.Values = list
		out.Fields = append(out.Fields, field)
	}
	return out
}

func truncateFacetValue(value string) (string, bool) {
	if utf8.RuneCountInString(value) <= MaxFacetValueLen {
		return value, false
	}
	runes := []rune(value)
	return string(runes[:MaxFacetValueLen]), true
}

// AggregateFacets computes facets over an in-memory slice of rows. It is the
// pure, Bleve-free core (used directly by the legacy full-window search path
// and by unit tests); Facets below streams a bounded scan through the same
// aggregator.
func AggregateFacets(hits []map[string]interface{}) *types.FacetsResponse {
	agg := newFacetAggregator()
	for _, hit := range hits {
		agg.Add(hit)
	}
	return agg.Result()
}

// Facets runs a bounded scan of the rows matching options (query, sources,
// time range -- Limit/Offset/Fields are ignored) and aggregates their field
// values. The scan walks the newest rows first in the same order as
// SearchPage, up to MaxFacetSampleRows; Sampled reports whether the window
// held more rows than that.
func (s *Storage) Facets(ctx context.Context, options SearchOptions) (*types.FacetsResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	empty := &types.FacetsResponse{ComputedOver: 0, Fields: []types.FacetField{}}
	if options.EndDate.Before(options.StartDate) {
		return empty, nil
	}
	dates, err := s.List()
	if err != nil {
		return nil, fmt.Errorf("failed to list existing dates: %w", err)
	}
	selectedDates := intersectingDates(dates, options.StartDate, options.EndDate)
	if len(selectedDates) == 0 {
		return empty, nil
	}
	for _, date := range selectedDates {
		if _, err := s.getOrCreateIndex(date); err != nil {
			return nil, fmt.Errorf("failed to get index for date %s: %w", date, err)
		}
	}

	// The read lock is held for the whole scan (up to MaxFacetSampleRows /
	// facetScanBatchSize batches), like SearchPage holds it for one page.
	// Clear/PruneOlderThan take the write lock, so a retention sweep and a
	// large facet scan stall each other; no deadlock, but a lease-per-batch
	// (re-resolving indexes between batches) is on the next-10 list.
	s.mu.RLock()
	defer s.mu.RUnlock()

	indexes := make([]bleve.Index, 0, len(selectedDates))
	timestampsIndexed := true
	fieldSet := map[string]struct{}{"timestamp": {}} // needed for the exact-range filter
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
			return nil, fmt.Errorf("failed to list fields for date %s: %w", date, fieldErr)
		}
		for _, field := range fields {
			// Never pull _raw (the whole line) or ordering metadata through the
			// scan: they are not faceted and would dominate the bytes read.
			if field == "_raw" || field == "_seq" || field == "_all" || field == "_id" {
				continue
			}
			fieldSet[field] = struct{}{}
		}
	}
	if len(indexes) == 0 {
		return empty, nil
	}
	requested := make([]string, 0, len(fieldSet))
	for field := range fieldSet {
		requested = append(requested, field)
	}
	sort.Strings(requested)

	baseQuery, err := buildPageQuery(options.Query, options.Sources)
	if err != nil {
		return nil, err
	}
	if timestampsIndexed {
		inclusive := true
		timeQuery := query.NewDateRangeInclusiveQuery(options.StartDate, options.EndDate, &inclusive, &inclusive)
		timeQuery.SetField("timestamp")
		baseQuery = bleve.NewConjunctionQuery(baseQuery, timeQuery)
	}
	alias := bleve.NewIndexAlias(indexes...)

	agg := newFacetAggregator()
	// Dedupe by document ID across batches: the shared timestampSort cursor
	// re-includes rows that share a timestamp at a search-after seam (see
	// search_page_seams_test.go / ISSUES.md), and a facet count must be
	// exact for the rows it claims to cover.
	seen := make(map[string]struct{}, facetScanBatchSize)
	var searchAfter []string
	var total uint64
	first := true
	for agg.rows < MaxFacetSampleRows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		request := bleve.NewSearchRequest(baseQuery)
		request.Size = facetScanBatchSize
		if remaining := MaxFacetSampleRows - agg.rows; remaining < request.Size {
			request.Size = remaining
		}
		request.Fields = requested
		request.SortByCustom(timestampSort("desc"))
		if len(searchAfter) > 0 {
			request.SetSearchAfter(searchAfter)
		}
		result, searchErr := alias.SearchInContext(ctx, request)
		if searchErr != nil {
			return nil, searchErr
		}
		if first {
			total = result.Total
			first = false
		}
		if len(result.Hits) == 0 {
			break
		}
		for _, hit := range result.Hits {
			if _, dup := seen[hit.ID]; dup {
				continue
			}
			seen[hit.ID] = struct{}{}
			entry, timestamp, ok := pageHitToLog(hit.ID, hit.Fields)
			if !ok || timestamp.Before(options.StartDate) || timestamp.After(options.EndDate) {
				continue
			}
			agg.Add(entry)
		}
		last := result.Hits[len(result.Hits)-1]
		searchAfter = last.DecodedSort
		if len(searchAfter) == 0 {
			searchAfter = last.Sort
		}
		if len(searchAfter) == 0 || len(result.Hits) < request.Size {
			break
		}
	}
	out := agg.Result()
	// On legacy shards (timestamp not indexed) Total counts candidates, not
	// rows inside the exact range, so Sampled may over-report there; the
	// bounded scan itself is still correct.
	out.Sampled = uint64(agg.rows) < total && agg.rows >= MaxFacetSampleRows
	return out, nil
}
