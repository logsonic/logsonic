package storage

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/search/query"
)

// ScanResult reports how much of a window a bounded scan covered.
type ScanResult struct {
	// Rows is the number of in-window rows passed to the callback.
	Rows int
	// Total is the number of rows the query matched. On legacy shards
	// (timestamp not indexed) it counts candidates, not rows inside the
	// exact range.
	Total uint64
	// Truncated reports that the window held more rows than were scanned.
	Truncated bool
}

// ScanRows walks the rows matching options (query, sources, time range;
// Limit/Offset are ignored) newest first, in the same order as SearchPage,
// and passes each in-window row to fn, up to maxRows rows. options.Fields
// limits the fields loaded (timestamp is always added); empty loads every
// field except _raw and ordering metadata. fn must not retain the row past
// the call if it mutates it.
func (s *Storage) ScanRows(ctx context.Context, options SearchOptions, maxRows int, fn func(map[string]interface{})) (ScanResult, error) {
	if err := ctx.Err(); err != nil {
		return ScanResult{}, err
	}
	if options.EndDate.Before(options.StartDate) || maxRows <= 0 {
		return ScanResult{}, nil
	}
	dates, err := s.List()
	if err != nil {
		return ScanResult{}, fmt.Errorf("failed to list existing dates: %w", err)
	}
	selectedDates := intersectingDates(dates, options.StartDate, options.EndDate)
	if len(selectedDates) == 0 {
		return ScanResult{}, nil
	}
	for _, date := range selectedDates {
		if _, err := s.getOrCreateIndex(date); err != nil {
			return ScanResult{}, fmt.Errorf("failed to get index for date %s: %w", date, err)
		}
	}

	// The read lock is held for the whole scan (up to maxRows /
	// scanBatchSize batches), like SearchPage holds it for one page.
	// Clear/PruneOlderThan take the write lock, so a retention sweep and a
	// large scan stall each other; no deadlock, but a lease-per-batch
	// (re-resolving indexes between batches) is on the next-10 list.
	s.mu.RLock()
	defer s.mu.RUnlock()

	indexes := make([]bleve.Index, 0, len(selectedDates))
	timestampsIndexed := true
	fieldSet := map[string]struct{}{"timestamp": {}} // needed for the exact-range filter
	for _, field := range options.Fields {
		fieldSet[field] = struct{}{}
	}
	for _, date := range selectedDates {
		index, ok := s.indices[date]
		if !ok {
			continue
		}
		indexes = append(indexes, index)
		if !timestampIsIndexed(index) {
			timestampsIndexed = false
		}
		if len(options.Fields) > 0 {
			continue
		}
		fields, fieldErr := index.Fields()
		if fieldErr != nil {
			return ScanResult{}, fmt.Errorf("failed to list fields for date %s: %w", date, fieldErr)
		}
		for _, field := range fields {
			// Never pull _raw (the whole line) or ordering metadata through the
			// scan: they would dominate the bytes read.
			if field == "_raw" || field == "_seq" || field == "_all" || field == "_id" {
				continue
			}
			fieldSet[field] = struct{}{}
		}
	}
	if len(indexes) == 0 {
		return ScanResult{}, nil
	}
	requested := make([]string, 0, len(fieldSet))
	for field := range fieldSet {
		requested = append(requested, field)
	}
	sort.Strings(requested)

	baseQuery, err := buildPageQuery(options.Query, options.Sources)
	if err != nil {
		return ScanResult{}, err
	}
	alias := bleve.NewIndexAlias(indexes...)
	scan := rowScan{ctx: ctx, alias: alias, base: baseQuery, fields: requested, timeFilter: timestampsIndexed, maxRows: maxRows, fn: fn}

	// Each search-after batch re-collects every match after the cursor, so
	// one cursor over the whole window costs O(rows^2 / batch). Walking
	// disjoint time slices newest first keeps each search small. Slices are
	// half-open except the newest, which keeps the window's inclusive end.
	total, err := scan.count(options.StartDate, options.EndDate)
	if err != nil {
		return ScanResult{}, err
	}
	// Slice the span the matching rows actually cover, not the requested
	// window: a one-day import inside a default one-year window would
	// otherwise land in a single slice.
	lo, hi := options.StartDate, options.EndDate
	slices := 1
	if timestampsIndexed && total > scanSliceRows {
		first, last, err := scan.span(lo, hi)
		if err != nil {
			return ScanResult{}, err
		}
		if !first.IsZero() && !last.IsZero() && last.After(first) {
			lo, hi = first, last
			slices = min(scanMaxSlices, max(1, int(total/scanSliceRows)))
		}
	}
	width := hi.Sub(lo) / time.Duration(slices)
	if width <= 0 {
		slices = 1
	}
	stalled := false
	for i := slices - 1; i >= 0 && scan.rows < maxRows; i-- {
		from, to := lo.Add(time.Duration(i)*width), lo.Add(time.Duration(i+1)*width-time.Nanosecond)
		if i == 0 {
			from = options.StartDate
		}
		if i == slices-1 {
			to = options.EndDate
		}
		ok, err := scan.walk(from, to)
		if err != nil {
			return ScanResult{}, err
		}
		stalled = stalled || !ok
	}
	out := ScanResult{Rows: scan.rows, Total: total}
	if stalled {
		out.Truncated = uint64(out.Rows) < out.Total
	} else {
		out.Truncated = uint64(out.Rows) < out.Total && out.Rows >= maxRows
	}
	return out, nil
}

const (
	// scanSliceRows is the target number of rows per time slice.
	scanSliceRows = 5000
	scanMaxSlices = 2000
)

// scanBatchSize is the search-after page size. A variable so tests can force
// seams with few rows.
var scanBatchSize = 2*scanSliceRows + 1

type rowScan struct {
	ctx        context.Context
	alias      bleve.IndexAlias
	base       query.Query
	fields     []string
	timeFilter bool
	maxRows    int
	rows       int
	fn         func(map[string]interface{})
}

func (r *rowScan) query(from, to time.Time) query.Query {
	if !r.timeFilter {
		return r.base
	}
	inclusive := true
	timeQuery := query.NewDateRangeInclusiveQuery(from, to, &inclusive, &inclusive)
	timeQuery.SetField("timestamp")
	return bleve.NewConjunctionQuery(r.base, timeQuery)
}

func (r *rowScan) count(from, to time.Time) (uint64, error) {
	request := bleve.NewSearchRequest(r.query(from, to))
	request.Size = 0
	result, err := r.alias.SearchInContext(r.ctx, request)
	if err != nil {
		return 0, err
	}
	return result.Total, nil
}

// span returns the oldest and newest matching timestamps in [from, to].
func (r *rowScan) span(from, to time.Time) (time.Time, time.Time, error) {
	var out [2]time.Time
	for i, order := range []string{"asc", "desc"} {
		request := bleve.NewSearchRequest(r.query(from, to))
		request.Size = 1
		request.Fields = []string{"timestamp"}
		request.SortByCustom(timestampSort(order))
		result, err := r.alias.SearchInContext(r.ctx, request)
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		if len(result.Hits) > 0 {
			_, ts, _ := pageHitToLog(result.Hits[0].ID, result.Hits[0].Fields)
			out[i] = ts
		}
	}
	return out[0], out[1], nil
}

// walk passes the in-range rows of [from, to] to fn, newest first, until
// maxRows rows have been passed in total. It returns false when the cursor
// stalled before the range was exhausted.
func (r *rowScan) walk(from, to time.Time) (bool, error) {
	// Dedupe by document ID across batches: the shared timestampSort cursor
	// re-includes rows that share a timestamp at a search-after seam (see
	// search_page_seams_test.go / ISSUES.md), and a count must be exact for
	// the rows it claims to cover.
	seen := make(map[string]struct{}, scanSliceRows)
	var searchAfter []string
	q := r.query(from, to)
	for r.rows < r.maxRows {
		if err := r.ctx.Err(); err != nil {
			return false, err
		}
		request := bleve.NewSearchRequest(q)
		// Ask for one row more than remains: the first row of a batch can
		// repeat the last row of the previous one at a seam. A batch spans a
		// whole typical slice, because every batch re-reads the sort keys of
		// all rows after the cursor.
		request.Size = scanBatchSize
		if remaining := r.maxRows - r.rows + 1; remaining < request.Size {
			request.Size = remaining
		}
		request.Fields = r.fields
		request.SortByCustom(timestampSort("desc"))
		if len(searchAfter) > 0 {
			request.SetSearchAfter(searchAfter)
		}
		result, err := r.alias.SearchInContext(r.ctx, request)
		if err != nil {
			return false, err
		}
		if len(result.Hits) == 0 {
			return true, nil
		}
		newHits := 0
		for _, hit := range result.Hits {
			if r.rows >= r.maxRows {
				break
			}
			if _, dup := seen[hit.ID]; dup {
				continue
			}
			seen[hit.ID] = struct{}{}
			newHits++
			entry, timestamp, ok := pageHitToLog(hit.ID, hit.Fields)
			// With an indexed timestamp the query already applied the exact
			// range. Re-checking the stored value would drop sub-second rows
			// near a slice edge, because the stored text keeps whole seconds.
			if !ok || (!r.timeFilter && (timestamp.Before(from) || timestamp.After(to))) {
				continue
			}
			r.rows++
			r.fn(entry)
		}
		// A batch that added nothing new means the search-after cursor did
		// not advance -- observed in practice when a tied sort key sits
		// exactly at the shrinking tail window: the same already-`seen`
		// page comes back forever and the loop never reaches maxRows. Bail
		// out rather than spin: this is the same tied-timestamp/unindexed-
		// _seq class of bug as the search-after-seam entry in ISSUES.md,
		// just surfacing as a hang instead of a miscount. next-10's
		// cursor-paging fix is the real cure; this stops the scan from
		// holding s.mu.RLock() forever in the meantime.
		if newHits == 0 {
			return false, nil
		}
		last := result.Hits[len(result.Hits)-1]
		searchAfter = last.DecodedSort
		if len(searchAfter) == 0 {
			searchAfter = last.Sort
		}
		if len(searchAfter) == 0 || len(result.Hits) < request.Size {
			return true, nil
		}
	}
	return true, nil
}
