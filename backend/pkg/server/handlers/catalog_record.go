package handlers

import (
	"log"

	"logsonic/pkg/catalog"
	"logsonic/pkg/types"
)

// storedBatch is what a write path reports after a successful Store: the
// session/tail options it stored under, where the rows came from, and the
// raw lines + parsed rows themselves. recordStored derives the catalog
// Batch from it and invalidates the /info cache (which still holds the
// total row count and on-disk size, neither of which the catalog owns).
type storedBatch struct {
	Opts        types.IngestSessionOptions
	Origin      types.SourceOrigin
	ImportID    string
	ImportJobID string
	Lines       []string
	Rows        []map[string]interface{}
}

func (h *Services) recordStored(b storedBatch) {
	h.InvalidateInfoCache()
	if h.Catalog == nil || len(b.Rows) == 0 {
		return
	}
	// One Batch per stored _src value. A batch normally carries exactly
	// one, so the raw-byte total is attributed whole; if a caller ever
	// stamps rows with several, bytes are split by row share.
	summaries := catalog.SummarizeRows(b.Rows, b.Opts.Source)
	totalBytes := catalog.SumBytes(b.Lines)
	totalRows := int64(len(b.Rows))
	// Only a path-backed import is replayable, so only those record the
	// options a re-import will use; a later browser upload or stdin tail
	// of the same source must not overwrite them with unusable ones.
	var importOptions *types.IngestSessionOptions
	if b.Origin.Path != "" {
		opts := b.Opts
		importOptions = &opts
	}
	for src, s := range summaries {
		bytes := totalBytes
		if len(summaries) > 1 && totalRows > 0 {
			bytes = totalBytes * s.Rows / totalRows
		}
		h.Catalog.Record(catalog.Batch{
			Source:        src,
			Origin:        b.Origin,
			PatternName:   b.Opts.Name,
			Pattern:       b.Opts.Pattern,
			Rows:          s.Rows,
			Bytes:         bytes,
			FirstTS:       s.FirstTS,
			LastTS:        s.LastTS,
			DayRows:       s.DayRows,
			ImportID:      b.ImportID,
			ImportPath:    b.Origin.Path,
			ImportJobID:   b.ImportJobID,
			ImportOptions: importOptions,
		})
	}
}

// catalogSources is the /info view of the catalog: the compatibility name
// list plus the per-source row counts. Both are non-nil so the JSON is []
// rather than null on an empty store.
func (h *Services) catalogSources() ([]string, []types.SourceRowsEntry) {
	names := []string{}
	sources := []types.SourceRowsEntry{}
	if h.Catalog == nil {
		return names, sources
	}
	for _, e := range h.Catalog.List() {
		names = append(names, e.Name)
		sources = append(sources, types.SourceRowsEntry{Name: e.Name, Rows: e.Rows})
	}
	return names, sources
}

// rebuildCatalog reconciles the catalog after an operation that bypassed
// the write path (Clear, DeleteByIds, retention prune). With no days it is
// a full rebuild.
func (h *Services) rebuildCatalog(days ...string) {
	if h.Catalog == nil {
		return
	}
	if err := h.Catalog.Rebuild(days...); err != nil {
		// Logged, not surfaced: the operation itself succeeded, and the
		// next startup or POST /sources/rebuild reconciles again.
		log.Printf("catalog: rebuild after index change failed: %v", err)
	}
}

// sourceFacetValues caps the _src facet like every other field (spec
// now-02: 8 values in the HTTP response).
const sourceFacetValues = 8

// overlaySourceFacet replaces the window-scoped _src facet with the
// catalog's corpus-wide view: every source with its exact row count (spec
// now-02, "_src is special"). Values are stored _src names, never display
// names — the Fields panel turns a click into +_src:"<value>", which is a
// raw field match. Applied on both search paths (SearchPage and the legacy
// Search + AggregateFacets branch).
func (h *Services) overlaySourceFacet(facets *types.FacetsResponse) {
	if h.Catalog == nil {
		return
	}
	top, distinct := h.Catalog.TopSources(sourceFacetValues)
	if distinct == 0 {
		return
	}
	field := types.FacetField{Name: "_src", Distinct: distinct, Values: make([]types.FacetValue, 0, len(top))}
	for _, s := range top {
		field.Values = append(field.Values, types.FacetValue{Value: s.Name, Count: int(s.Rows)})
	}
	for i := range facets.Fields {
		if facets.Fields[i].Name == "_src" {
			facets.Fields[i] = field
			return
		}
	}
	facets.Fields = append(facets.Fields, field)
}
