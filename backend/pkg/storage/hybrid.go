package storage

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/mapping"
	blevesearch "github.com/blevesearch/bleve/v2/search"
	index "github.com/blevesearch/bleve_index_api"
)

// rowPointerField is the only stored field of a compact shard: the
// "<day>/<block>" row block holding the document's full row. It is indexed as
// one keyword term so a block's live row count is a term query, which lets
// deletes reclaim blocks that no document references any more.
const rowPointerField = "_blk"

// StorageFormatEnv selects the on-disk format for new day shards.
// "legacy" keeps writing full Bleve stored fields and disables migration;
// anything else (the default) writes compact shards.
const StorageFormatEnv = "LOGSONIC_STORAGE_FORMAT"

// buildCompactIndexMapping indexes exactly what buildIndexMapping indexes,
// with the same analyzers and doc values, but stores nothing except the row
// pointer: the rows themselves live in the shard's row blocks.
func buildCompactIndexMapping() mapping.IndexMapping {
	indexMapping := buildIndexMapping().(*mapping.IndexMappingImpl)
	indexMapping.StoreDynamic = false
	for _, field := range []string{"timestamp", "_raw", "_src", "_seq"} {
		for _, fieldMapping := range indexMapping.DefaultMapping.Properties[field].Fields {
			fieldMapping.Store = false
		}
	}
	pointer := bleve.NewKeywordFieldMapping()
	pointer.Store = true
	pointer.Index = true
	pointer.IncludeInAll = false
	pointer.IncludeTermVectors = false
	pointer.DocValues = false
	indexMapping.DefaultMapping.AddFieldMappingsAt(rowPointerField, pointer)
	return indexMapping
}

// isCompactIndex reports whether a shard was created with the compact mapping.
func isCompactIndex(idx bleve.Index) bool {
	indexMapping, ok := idx.Mapping().(*mapping.IndexMappingImpl)
	if !ok || indexMapping.DefaultMapping == nil {
		return false
	}
	_, ok = indexMapping.DefaultMapping.Properties[rowPointerField]
	return ok
}

var (
	storedMappingOnce sync.Once
	storedMapping     mapping.IndexMapping
)

// storedRowMapping is the legacy mapping, used read-only to turn a row back
// into the stored-field document a legacy shard would have returned.
func storedRowMapping() mapping.IndexMapping {
	storedMappingOnce.Do(func() { storedMapping = buildIndexMapping() })
	return storedMapping
}

// storedDocument rebuilds the document Bleve would have stored for row. Going
// through the same mapping and field optimizer as the legacy write path keeps
// every returned value (float64 numbers, RFC 3339 datetimes, flattened
// nested keys, array values) identical to a legacy shard.
func storedDocument(id string, row map[string]interface{}) (index.Document, error) {
	return buildOptimizedDocument(storedRowMapping(), id, row)
}

// storedDocReader serves one prepared document to bleve.LoadAndHighlightFields.
type storedDocReader struct {
	index.IndexReader
	doc index.Document
}

func (r storedDocReader) Document(string) (index.Document, error) { return r.doc, nil }

// blockCache returns the shared decoded-block cache, creating it for a
// Storage built without newStorageWithFormat (tests construct those).
func (s *Storage) blockCache() *rowBlockCache {
	s.rowsMu.Lock()
	defer s.rowsMu.Unlock()
	if s.rowCache == nil {
		s.rowCache = newRowBlockCache(rowBlockCacheSize)
	}
	return s.rowCache
}

func (s *Storage) setRowStore(day string, rs *rowStore) {
	s.rowsMu.Lock()
	defer s.rowsMu.Unlock()
	if s.rows == nil {
		s.rows = make(map[string]*rowStore)
	}
	s.rows[day] = rs
}

func (s *Storage) rowStoreFor(day string) *rowStore {
	s.rowsMu.RLock()
	defer s.rowsMu.RUnlock()
	return s.rows[day]
}

// rowFor resolves a row pointer. A nil row with a nil error means the pointer
// names no row, which only an interrupted write can leave behind.
func (s *Storage) rowFor(pointer, id string) (map[string]interface{}, error) {
	day, block, ok := parseRowBlockKey(pointer)
	if !ok {
		return nil, fmt.Errorf("invalid row pointer %q", pointer)
	}
	rs := s.rowStoreFor(day)
	if rs == nil {
		return nil, fmt.Errorf("row store for %s is not open", day)
	}
	return rs.row(block, id)
}

var missingRowOnce sync.Once

// searchRows runs req and replaces each compact-shard hit's `_blk` pointer
// with the stored fields the request asked for, so callers read hit.Fields
// exactly as they do for a legacy shard.
func (s *Storage) searchRows(ctx context.Context, idx bleve.Index, req *bleve.SearchRequest) (*bleve.SearchResult, error) {
	fields := req.Fields
	if len(fields) > 0 && !containsString(fields, "*") {
		req.Fields = append(append(make([]string, 0, len(fields)+1), fields...), rowPointerField)
		defer func() { req.Fields = fields }()
	}
	result, err := idx.SearchInContext(ctx, req)
	if err != nil {
		return nil, err
	}
	if len(fields) > 0 {
		if err := s.hydrateHits(result.Hits, fields); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Storage) hydrateHits(hits blevesearch.DocumentMatchCollection, fields []string) error {
	var request *bleve.SearchRequest
	for _, hit := range hits {
		pointer, ok := rowPointerValue(hit.Fields[rowPointerField])
		if !ok {
			continue
		}
		hit.Fields = nil
		row, err := s.rowFor(pointer, hit.ID)
		if err != nil {
			return err
		}
		if row == nil {
			missingRowOnce.Do(func() {
				log.Printf("storage: document %s points at %s but the row is missing; it will be skipped", hit.ID, pointer)
			})
			continue
		}
		doc, err := storedDocument(hit.ID, row)
		if err != nil {
			return err
		}
		if request == nil {
			request = &bleve.SearchRequest{Fields: fields}
		}
		if err, _ := bleve.LoadAndHighlightFields(hit, request, "", storedDocReader{doc: doc}, nil); err != nil {
			return err
		}
	}
	return nil
}

func rowPointerValue(value interface{}) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case []interface{}:
		if len(v) > 0 {
			pointer, ok := v[0].(string)
			return pointer, ok
		}
	}
	return "", false
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// rowResolver lets phrase verification read full rows on compact shards.
type rowResolver interface {
	phraseDocument(reader index.IndexReader, id string) (index.Document, error)
	phraseText(reader index.IndexReader, id, field string) (values []string, doc index.Document, err error)
}

// phraseText returns the text values of field for a phrase check. On a
// compact shard it reads them straight from the row, without rebuilding the
// whole stored document; on a legacy shard it returns the stored document
// for the caller to visit. A document is a phrase candidate only when field
// holds the phrase's terms as text, so the row value is text there too.
func (s *Storage) phraseText(reader index.IndexReader, id, field string) ([]string, index.Document, error) {
	doc, err := reader.Document(id)
	if err != nil || doc == nil {
		return nil, nil, err
	}
	pointer := ""
	doc.VisitFields(func(f index.Field) {
		if f.Name() == rowPointerField {
			pointer = string(f.Value())
		}
	})
	if pointer == "" {
		return nil, doc, nil
	}
	row, err := s.rowFor(pointer, id)
	if err != nil || row == nil {
		return nil, nil, err
	}
	return appendTextValues(nil, rowValue(row, field)), nil, nil
}

// rowValue finds field in a row, following dotted paths into nested maps the
// way the mapping flattened them.
func rowValue(row map[string]interface{}, field string) interface{} {
	if value, ok := row[field]; ok {
		return value
	}
	for i := 0; i < len(field); i++ {
		if field[i] != '.' {
			continue
		}
		if nested, ok := row[field[:i]].(map[string]interface{}); ok {
			if value := rowValue(nested, field[i+1:]); value != nil {
				return value
			}
		}
	}
	return nil
}

func appendTextValues(out []string, value interface{}) []string {
	switch v := value.(type) {
	case string:
		out = append(out, v)
	case []string:
		out = append(out, v...)
	case []interface{}:
		for _, item := range v {
			out = appendTextValues(out, item)
		}
	}
	return out
}

// phraseDocument returns the full stored document for id, from the row
// blocks when the shard is compact.
func (s *Storage) phraseDocument(reader index.IndexReader, id string) (index.Document, error) {
	doc, err := reader.Document(id)
	if err != nil || doc == nil {
		return doc, err
	}
	pointer := ""
	doc.VisitFields(func(field index.Field) {
		if field.Name() == rowPointerField {
			pointer = string(field.Value())
		}
	})
	if pointer == "" {
		return doc, nil
	}
	row, err := s.rowFor(pointer, id)
	if err != nil || row == nil {
		return nil, err
	}
	return storedDocument(id, row)
}

// repairOpenBlock removes documents whose rows a power loss took: documents
// pointing at a block that has no file (sealed after the last checkpoint and
// not recoverable from the WAL), and documents of the open block whose rows
// the WAL lost. The rows were never durable, so the documents must not stay
// searchable without them.
func repairOpenBlock(idx bleve.Index, rs *rowStore) (int, error) {
	dict, err := idx.FieldDict(rowPointerField)
	if err != nil {
		return 0, err
	}
	var missing []string
	for {
		entry, err := dict.Next()
		if err != nil {
			_ = dict.Close()
			return 0, err
		}
		if entry == nil {
			break
		}
		_, block, ok := parseRowBlockKey(entry.Term)
		rs.mu.Lock()
		_, sealed := rs.sealed[block]
		open := block == rs.open
		rs.mu.Unlock()
		if !ok || (!sealed && !open) {
			missing = append(missing, entry.Term)
		}
	}
	if err := dict.Close(); err != nil {
		return 0, err
	}

	batch := idx.NewBatch()
	collect := func(pointer string, keep func(id string) bool) error {
		term := bleve.NewTermQuery(pointer)
		term.SetField(rowPointerField)
		req := bleve.NewSearchRequest(term)
		req.Size = 10000
		for {
			result, err := idx.Search(req)
			if err != nil {
				return err
			}
			for _, hit := range result.Hits {
				if !keep(hit.ID) {
					batch.Delete(hit.ID)
				}
			}
			if len(result.Hits) < req.Size {
				return nil
			}
			req.From += req.Size
		}
	}
	for _, pointer := range missing {
		if err := collect(pointer, func(string) bool { return false }); err != nil {
			return 0, err
		}
	}
	rs.mu.Lock()
	openPointer := rowBlockKey(rs.day, rs.open)
	rs.mu.Unlock()
	if err := collect(openPointer, func(id string) bool {
		rs.mu.Lock()
		defer rs.mu.Unlock()
		_, ok := rs.rows[id]
		return ok
	}); err != nil {
		return 0, err
	}
	if batch.Size() == 0 {
		return 0, nil
	}
	log.Printf("storage: removing %d document(s) of %s whose rows were not written before a crash", batch.Size(), rs.day)
	return batch.Size(), idx.Batch(batch)
}

// blockLiveRows counts the documents still pointing at one row block.
func blockLiveRows(idx bleve.Index, pointer string) (uint64, error) {
	term := bleve.NewTermQuery(pointer)
	term.SetField(rowPointerField)
	req := bleve.NewSearchRequest(term)
	req.Size = 0
	result, err := idx.Search(req)
	if err != nil {
		return 0, err
	}
	return result.Total, nil
}

// reclaimRowBlocks runs after deletes on a compact day, under its write lock.
// Blocks no document references are removed. Blocks where most rows are dead
// have their live rows rewritten into the open block (re-pointing their
// documents) and are then removed, so deleting or re-importing a source
// gives its disk space back as a legacy shard's segment merges would.
func (s *Storage) reclaimRowBlocks(idx bleve.Index, rs *rowStore) error {
	for _, block := range sortedBlocks(rs.sealedBlocks()) {
		written := rs.sealedBlocks()[block]
		pointer := rowBlockKey(rs.day, block)
		live, err := blockLiveRows(idx, pointer)
		if err != nil {
			return err
		}
		if live > 0 && live*2 >= uint64(written) {
			continue
		}
		if live > 0 {
			if err := s.rewriteLiveRows(idx, rs, block, pointer); err != nil {
				return err
			}
		}
		if err := rs.dropBlock(block); err != nil {
			return err
		}
	}
	return nil
}

func (s *Storage) rewriteLiveRows(idx bleve.Index, rs *rowStore, block uint64, pointer string) error {
	rows, err := rs.block(block)
	if err != nil {
		return err
	}
	var live []templateRecord
	for id, row := range rows {
		doc, err := idx.Document(id)
		if err != nil {
			return err
		}
		if doc == nil {
			continue
		}
		current := ""
		doc.VisitFields(func(field index.Field) {
			if field.Name() == rowPointerField {
				current = string(field.Value())
			}
		})
		if current == pointer {
			live = append(live, templateRecord{ID: id, Fields: row})
		}
	}
	return s.indexCompactRecords(idx, rs, live)
}

// indexCompactRecords makes records durable in the row store, then indexes
// them in one Bleve batch, as a legacy shard indexes one Store call. Rows are
// appended in chunks that never straddle a row block; every append completes
// before the batch, so an indexed document always finds its row.
func (s *Storage) indexCompactRecords(idx bleve.Index, rs *rowStore, records []templateRecord) error {
	batch := idx.NewBatch()
	for len(records) > 0 {
		n := len(records)
		if n > rowBlockSize {
			n = rowBlockSize
		}
		chunk := records[:n]
		records = records[n:]
		pointer, err := rs.append(chunk)
		if err != nil {
			return err
		}
		for _, record := range chunk {
			fields := make(map[string]interface{}, len(record.Fields)+1)
			for key, value := range record.Fields {
				fields[key] = value
			}
			fields[rowPointerField] = pointer
			doc, err := buildOptimizedDocument(idx.Mapping(), record.ID, fields)
			if err != nil {
				return fmt.Errorf("failed to index log entry: %w", err)
			}
			if err := batch.IndexAdvanced(doc); err != nil {
				return fmt.Errorf("failed to add log entry to batch: %w", err)
			}
		}
	}
	if batch.Size() == 0 {
		return nil
	}
	return idx.Batch(batch)
}

func legacyFormatFromEnv() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(StorageFormatEnv)), "legacy")
}
