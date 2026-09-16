package storage

import (
	"fmt"
	"log"
	"time"

	"github.com/blevesearch/bleve/v2"
	blevesearch "github.com/blevesearch/bleve/v2/search"
)

// SourceDayStats is what one day-index knows about one source: how many
// documents carry that _src and the timestamp span they cover. It is the
// raw material for the catalog's Rebuild (pkg/catalog); everything else in
// a catalog entry (origin, pattern, imports) is not derivable from the index.
// FirstTS/LastTS are whole seconds: Bleve hands stored datetimes back as
// RFC 3339 without the fractional part (the search path has the same
// limit), so a rebuilt bound can be up to 999 ms earlier than the value
// the write path recorded.
type SourceDayStats struct {
	Source  string
	Rows    uint64
	FirstTS time.Time
	LastTS  time.Time
}

// sourceFacetLimit bounds the per-day _src facet. Sources are files, tails
// and streams, not free text, so a day with more than this many distinct
// sources is not a case the product is designed for; a shard that somehow
// exceeds it reports the first N and the caller logs the truncation.
const sourceFacetLimit = 10000

// legacyReadPageSize is the stored-field read page for shards created before
// _src was keyword-mapped (see buildIndexMapping).
const legacyReadPageSize = 10000

// SourceStats returns per-source document counts and timestamp bounds for
// one day-index. On shards whose _src is keyword-mapped this is one size-0
// facet query for the counts plus two size-1 sorted queries per source for
// the bounds — no document is fetched. On shards created before that mapping
// existed, _src is tokenized (a facet would return "app" and "log", not
// "app.log"), so the only exact source of truth is the stored field; those
// shards are read page by page with stored _src + timestamp only. A missing
// day returns an empty slice, not an error.
func (s *Storage) SourceStats(date string) ([]SourceDayStats, error) {
	s.mu.RLock()
	index, ok := s.indices[date]
	s.mu.RUnlock()
	if !ok {
		return nil, nil
	}
	if index.Mapping().AnalyzerNameForPath("_src") == "keyword" {
		return sourceStatsByFacet(index)
	}
	return sourceStatsByStoredFields(index)
}

// LegacySourceShard reports whether the day-index predates the keyword _src
// mapping, i.e. whether SourceStats has to read stored fields for it. The
// catalog logs this so a slow rebuild is explainable.
func (s *Storage) LegacySourceShard(date string) bool {
	s.mu.RLock()
	index, ok := s.indices[date]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	return index.Mapping().AnalyzerNameForPath("_src") != "keyword"
}

func sourceStatsByFacet(index bleve.Index) ([]SourceDayStats, error) {
	req := bleve.NewSearchRequest(bleve.NewMatchAllQuery())
	req.Size = 0
	req.AddFacet("src", bleve.NewFacetRequest("_src", sourceFacetLimit))
	res, err := index.Search(req)
	if err != nil {
		return nil, fmt.Errorf("source facet: %w", err)
	}
	facet := res.Facets["src"]
	if facet == nil || facet.Terms == nil {
		return nil, nil
	}
	terms := facet.Terms.Terms()
	if len(terms) >= sourceFacetLimit {
		log.Printf("storage: _src facet hit its %d-term cap; the sources catalog may be missing sources for this day", sourceFacetLimit)
	}
	stats := make([]SourceDayStats, 0, len(terms))
	for _, term := range terms {
		first, last, err := sourceBounds(index, term.Term)
		if err != nil {
			return nil, err
		}
		stats = append(stats, SourceDayStats{
			Source:  term.Term,
			Rows:    uint64(term.Count),
			FirstTS: first,
			LastTS:  last,
		})
	}
	return stats, nil
}

// sourceBounds runs two size-1 queries sorted by timestamp asc / desc,
// filtered to one exact _src term.
func sourceBounds(index bleve.Index, source string) (first, last time.Time, err error) {
	for _, order := range []string{"asc", "desc"} {
		tq := bleve.NewTermQuery(source)
		tq.SetField("_src")
		req := bleve.NewSearchRequest(tq)
		req.Size = 1
		req.Fields = []string{"timestamp"}
		req.SortBy([]string{"timestamp"})
		if order == "desc" {
			req.SortBy([]string{"-timestamp"})
		}
		res, qerr := index.Search(req)
		if qerr != nil {
			return first, last, fmt.Errorf("source bounds (%s, %s): %w", source, order, qerr)
		}
		if len(res.Hits) == 0 {
			continue
		}
		ts, ok := parseStoredTimestamp(res.Hits[0].Fields["timestamp"])
		if !ok {
			continue
		}
		if order == "asc" {
			first = ts
		} else {
			last = ts
		}
	}
	return first, last, nil
}

func sourceStatsByStoredFields(index bleve.Index) ([]SourceDayStats, error) {
	acc := make(map[string]*SourceDayStats)
	var searchAfter []string
	for {
		req := bleve.NewSearchRequest(bleve.NewMatchAllQuery())
		req.Size = legacyReadPageSize
		req.Fields = []string{"_src", "timestamp"}
		req.Sort = blevesearch.SortOrder{&blevesearch.SortDocID{}}
		if len(searchAfter) > 0 {
			req.SetSearchAfter(searchAfter)
		}
		res, err := index.Search(req)
		if err != nil {
			return nil, fmt.Errorf("legacy source read: %w", err)
		}
		if len(res.Hits) == 0 {
			break
		}
		for _, hit := range res.Hits {
			source, _ := hit.Fields["_src"].(string)
			if source == "" {
				continue
			}
			entry := acc[source]
			if entry == nil {
				entry = &SourceDayStats{Source: source}
				acc[source] = entry
			}
			entry.Rows++
			if ts, ok := parseStoredTimestamp(hit.Fields["timestamp"]); ok {
				if entry.FirstTS.IsZero() || ts.Before(entry.FirstTS) {
					entry.FirstTS = ts
				}
				if ts.After(entry.LastTS) {
					entry.LastTS = ts
				}
			}
		}
		last := res.Hits[len(res.Hits)-1]
		searchAfter = last.DecodedSort
		if len(searchAfter) == 0 {
			searchAfter = []string{last.ID}
		}
		if len(res.Hits) < legacyReadPageSize {
			break
		}
	}
	stats := make([]SourceDayStats, 0, len(acc))
	for _, entry := range acc {
		stats = append(stats, *entry)
	}
	return stats, nil
}

// parseStoredTimestamp decodes the stored timestamp field, which Bleve hands
// back as an RFC 3339 string.
func parseStoredTimestamp(raw interface{}) (time.Time, bool) {
	switch v := raw.(type) {
	case string:
		ts, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return time.Time{}, false
		}
		return ts, true
	case time.Time:
		return v, true
	}
	return time.Time{}, false
}
