package storage

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"logsonic/pkg/types"
)

// The operation lease keeps a query's memory-index handles alive through close,
// deletion and commit. Delegation intentionally preserves existing query semantics.
func (s *TemplateStorage) Search(q string, start, end *time.Time, sources []string) ([]map[string]interface{}, time.Duration, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return nil, 0, err
	}
	return s.store.Search(q, start, end, sources)
}
func (s *TemplateStorage) SearchPage(ctx context.Context, o SearchOptions) (SearchPageResult, error) {
	if err := ctx.Err(); err != nil {
		return SearchPageResult{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return SearchPageResult{}, err
	}
	return s.store.SearchPage(ctx, o)
}
func (s *TemplateStorage) Facets(ctx context.Context, o SearchOptions) (*types.FacetsResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.store.Facets(ctx, o)
}
func (s *TemplateStorage) List() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.store.List()
}
func (s *TemplateStorage) SourceStats(date string) ([]SourceDayStats, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.store.SourceStats(date)
}
func (s *TemplateStorage) LegacySourceShard(date string) bool { return false }
func (s *TemplateStorage) GetDocCount(date string) (uint64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return 0, err
	}
	if err := validTemplateDate(date); err != nil {
		return 0, err
	}
	index, ok := s.store.indices[date]
	if !ok {
		return 0, nil
	}
	return index.DocCount()
}
func (s *TemplateStorage) IndexDirSize(date string) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.ready(); err != nil {
		return 0, err
	}
	if err := validTemplateDate(date); err != nil {
		return 0, err
	}
	var total int64
	err := filepath.Walk(filepath.Join(s.dir, date), func(_ string, info os.FileInfo, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
