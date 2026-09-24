package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/blevesearch/bleve/v2"
)

// deleteSourceBatch is how many candidate documents one delete batch holds
// (spec now-10: "batches of 5k").
var deleteSourceBatch = 5000 // var so a test can shrink it to exercise the legacy paging path

// DeleteBySource removes every document whose stored _src equals source from
// the given day-indices, returning the rows removed and the days that lost
// at least one. Days that end up empty are left in place for the caller to
// RemoveDay — a delete of one source must not silently drop another's
// (empty) shard, and the catalog decides what "empty" means.
//
// Candidates are found with a term query on keyword-mapped shards, where the
// term is the whole name. On shards created before that mapping _src is
// tokenized, so the query is a token-AND match that over-selects
// ("app.log" also hits "app.log.1"); there every candidate's stored _src is
// fetched and compared, and only exact matches are deleted. Each batch
// re-runs the same size-5000 query rather than paging with search-after:
// deleted documents vanish from the result, so the "next page" is simply
// the first 5000 again, and legacy verification stays exact across batches.
func (s *Storage) DeleteBySource(ctx context.Context, source string, dates []string) (rows int, daysTouched []string, err error) {
	if source == "" {
		return 0, nil, fmt.Errorf("empty source name")
	}
	for _, date := range dates {
		if err := ctx.Err(); err != nil {
			return rows, daysTouched, err
		}
		s.mu.RLock()
		index, ok := s.indices[date]
		s.mu.RUnlock()
		if !ok {
			continue
		}
		legacy := index.Mapping().AnalyzerNameForPath("_src") != "keyword"
		dayRows := 0
		for {
			ids, err := sourceCandidateIDs(index, source, legacy)
			if err != nil {
				return rows, daysTouched, fmt.Errorf("delete source %q from %s: %w", source, date, err)
			}
			if len(ids) == 0 {
				break
			}
			batch := index.NewBatch()
			for _, id := range ids {
				batch.Delete(id)
			}
			if err := index.Batch(batch); err != nil {
				return rows, daysTouched, fmt.Errorf("delete source %q from %s: %w", source, date, err)
			}
			dayRows += len(ids)
			rows += len(ids)
			if err := ctx.Err(); err != nil {
				return rows, daysTouched, err
			}
		}
		if dayRows > 0 {
			daysTouched = append(daysTouched, date)
		}
	}
	return rows, daysTouched, nil
}

// sourceCandidateIDs returns up to deleteSourceBatch document IDs whose _src
// is exactly source. On a legacy shard the match query over-selects, so the
// stored field is verified per hit and the page may come back shorter than
// the batch even though more matches exist — the caller loops until empty.
func sourceCandidateIDs(index bleve.Index, source string, legacy bool) ([]string, error) {
	req := bleve.NewSearchRequest(sourceFilterQuery(source))
	req.Size = deleteSourceBatch
	if legacy {
		req.Fields = []string{"_src"}
		// Sort by docID so this page's last sort key is a valid search-after
		// cursor for sourceCandidateIDsPaged, which uses the same sort.
		req.SortBy([]string{"_id"})
	}
	res, err := index.Search(req)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(res.Hits))
	for _, hit := range res.Hits {
		if legacy {
			if stored, _ := hit.Fields["_src"].(string); stored != source {
				continue
			}
		}
		ids = append(ids, hit.ID)
	}
	if legacy && len(ids) == 0 && len(res.Hits) == deleteSourceBatch {
		// A full page of over-selected non-matches hides real matches behind
		// it. Page past them by docID so the loop can still terminate.
		return sourceCandidateIDsPaged(index, source, res)
	}
	return ids, nil
}

// sourceCandidateIDsPaged continues a legacy-shard scan past a page of
// non-matching over-selections, using search-after on docID until it finds
// exact matches or runs out of candidates.
func sourceCandidateIDsPaged(index bleve.Index, source string, first *bleve.SearchResult) ([]string, error) {
	after := first.Hits[len(first.Hits)-1].DecodedSort
	for {
		req := bleve.NewSearchRequest(sourceFilterQuery(source))
		req.Size = deleteSourceBatch
		req.Fields = []string{"_src"}
		req.SortBy([]string{"_id"})
		if len(after) > 0 {
			req.SetSearchAfter(after)
		}
		res, err := index.Search(req)
		if err != nil {
			return nil, err
		}
		if len(res.Hits) == 0 {
			return nil, nil
		}
		ids := make([]string, 0, len(res.Hits))
		for _, hit := range res.Hits {
			if stored, _ := hit.Fields["_src"].(string); stored == source {
				ids = append(ids, hit.ID)
			}
		}
		if len(ids) > 0 || len(res.Hits) < deleteSourceBatch {
			return ids, nil
		}
		after = res.Hits[len(res.Hits)-1].DecodedSort
	}
}

// RemoveDay closes and deletes one day-index directory. Callers use it for a
// shard that reached zero documents after a per-source delete, and (phase
// 2b) for an explicit delete-day. A missing day is not an error. Like
// PruneOlderThan and Clear, it closes the index under the storage lock; a
// StoreWithIDs that already holds the handle from getOrCreateIndex sees the
// same closed-index error those two can cause today — recorded in
// ISSUES.md, not solved here.
func (s *Storage) RemoveDay(date string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index, ok := s.indices[date]; ok {
		if err := index.Close(); err != nil {
			return fmt.Errorf("close index %s: %w", date, err)
		}
		delete(s.indices, date)
	}
	path := filepath.Join(s.baseDir, "logs-"+date+".bleve")
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove index directory %s: %w", path, err)
	}
	return nil
}
