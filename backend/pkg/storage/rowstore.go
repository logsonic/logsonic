package storage

import (
	"container/list"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// A compact day shard keeps its rows outside Bleve. The Bleve index under
// logs-<day>.bleve/store holds only the inverted index, doc values and a
// small stored `_blk` pointer; the complete rows live next to it in
// logs-<day>.bleve/rows as immutable Zstandard blocks (the template codec):
//
//	rows/00000000000000000007-1024.zst  sealed block 7 holding 1024 rows
//	rows/open.wal                       frames for the block still filling
//
// Rows are appended to the WAL (fsync) before their documents are indexed,
// so every indexed document can find its row. A WAL frame whose rows never
// reached the index (a crash between the two) is dead bytes, never
// resurrected: a later delete is not recorded in the WAL, so replaying rows
// into the index could bring deleted rows back.
//
// The WAL is also what makes sealed blocks durable. Sealing writes a block
// with a plain fsync and leaves the WAL alone; once the WAL passes
// rowWALCheckpoint bytes, one full sync makes every block since the last
// checkpoint durable and the WAL is emptied. On open, a block the WAL still
// covers but whose file is missing is rebuilt from the WAL. This keeps
// sealing (every 1024 rows) off the cost of macOS's F_FULLFSYNC.
const (
	rowsDirName       = "rows"
	rowWALName        = "open.wal"
	rowBlockSize      = 1024
	rowWALFrameHead   = 12 // uint64 block number + uint32 frame length
	rowBlockCacheSize = 64 // decoded blocks kept across all days
	rowWALCheckpoint  = 8 << 20
)

// rowStore is one day's row blocks. Its methods are serialized by mu; the
// caller's per-day write lock orders appends against index batches and GC.
type rowStore struct {
	day    string
	dir    string
	cache  *rowBlockCache
	mu     sync.Mutex
	sealed map[uint64]int // block -> rows written
	open   uint64         // block receiving WAL appends
	rows   map[string]map[string]interface{}
	order  []string
	frames [][]byte // encoded WAL payloads of the open block
	wal    *os.File
	walLen int64
	closed bool
}

func rowBlockKey(day string, block uint64) string {
	return day + "/" + strconv.FormatUint(block, 10)
}

// parseRowBlockKey splits "<day>/<block>".
func parseRowBlockKey(key string) (string, uint64, bool) {
	i := strings.LastIndexByte(key, '/')
	if i <= 0 {
		return "", 0, false
	}
	block, err := strconv.ParseUint(key[i+1:], 10, 64)
	if err != nil || block == 0 {
		return "", 0, false
	}
	return key[:i], block, true
}

func sealedBlockName(block uint64, rows int) string {
	return fmt.Sprintf("%020d-%d.zst", block, rows)
}

func parseSealedBlockName(name string) (uint64, int, bool) {
	if !strings.HasSuffix(name, ".zst") {
		return 0, 0, false
	}
	parts := strings.SplitN(strings.TrimSuffix(name, ".zst"), "-", 2)
	if len(parts) != 2 || len(parts[0]) != 20 {
		return 0, 0, false
	}
	block, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil || block == 0 {
		return 0, 0, false
	}
	rows, err := strconv.Atoi(parts[1])
	if err != nil || rows < 0 {
		return 0, 0, false
	}
	return block, rows, true
}

// openRowStore loads the sealed block list and replays the WAL's open block.
func openRowStore(shardDir, day string, cache *rowBlockCache) (*rowStore, error) {
	dir := filepath.Join(shardDir, rowsDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	rs := &rowStore{day: day, dir: dir, cache: cache, sealed: map[uint64]int{}, rows: map[string]map[string]interface{}{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var last uint64
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case name == rowWALName:
		case strings.HasPrefix(name, "."):
			// Uncommitted temporary block or OS metadata.
			if strings.HasSuffix(name, ".tmp") {
				_ = os.Remove(filepath.Join(dir, name))
			}
		default:
			block, rows, ok := parseSealedBlockName(name)
			if !ok || entry.IsDir() {
				return nil, fmt.Errorf("unexpected row store entry %s", filepath.Join(dir, name))
			}
			rs.sealed[block] = rows
			if block > last {
				last = block
			}
		}
	}
	rs.open = last + 1
	if err := rs.replayWAL(last); err != nil {
		return nil, err
	}
	return rs, nil
}

func (rs *rowStore) walPath() string { return filepath.Join(rs.dir, rowWALName) }

// replayWAL restores the open block and rebuilds any block the WAL covers
// whose file is missing (sealed but not yet checkpointed before a power
// loss). Frames of blocks that have a file are skipped; a torn final frame
// is an unacknowledged append and is cut off.
func (rs *rowStore) replayWAL(lastSealed uint64) error {
	f, err := os.OpenFile(rs.walPath(), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	// Persist the WAL's (and rows/') directory entries before any append is
	// acknowledged through them.
	if err := errors.Join(syncTemplateDir(rs.dir), syncTemplateDir(filepath.Dir(rs.dir))); err != nil {
		_ = f.Close()
		return err
	}
	type pending struct {
		records []templateRecord
		frames  [][]byte
	}
	unsealed := map[uint64]*pending{}
	var good int64
	head := make([]byte, rowWALFrameHead)
	for {
		if _, err := io.ReadFull(f, head); err != nil {
			break
		}
		block := binary.BigEndian.Uint64(head)
		size := binary.BigEndian.Uint32(head[8:])
		payload := make([]byte, size)
		if _, err := io.ReadFull(f, payload); err != nil {
			break
		}
		segment, err := decodeTemplateSegment(payload)
		if err != nil || block == 0 {
			break
		}
		good += int64(rowWALFrameHead) + int64(size)
		if _, sealed := rs.sealed[block]; sealed {
			continue
		}
		p := unsealed[block]
		if p == nil {
			p = &pending{}
			unsealed[block] = p
		}
		p.records = append(p.records, segment.Records...)
		p.frames = append(p.frames, payload)
	}
	if err := f.Truncate(good); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Seek(good, io.SeekStart); err != nil {
		_ = f.Close()
		return err
	}
	rs.wal, rs.walLen = f, good

	blocks := make([]uint64, 0, len(unsealed))
	for block := range unsealed {
		blocks = append(blocks, block)
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i] < blocks[j] })
	// No checkpoint while rebuilding: later blocks still need their frames.
	rs.walLen = 0
	defer func() { rs.walLen = good }()
	for i, block := range blocks {
		rs.open = block
		for _, record := range unsealed[block].records {
			rs.remember(record)
		}
		rs.frames = unsealed[block].frames
		if i == len(blocks)-1 && block > lastSealed {
			break // the block that was still filling stays open
		}
		if err := rs.sealLocked(); err != nil {
			return err
		}
	}
	if rs.open <= lastSealed {
		rs.open = lastSealed + 1
	}
	for {
		if _, ok := rs.sealed[rs.open]; !ok {
			break
		}
		rs.open++
	}
	return nil
}

func (rs *rowStore) remember(record templateRecord) {
	if _, ok := rs.rows[record.ID]; !ok {
		rs.order = append(rs.order, record.ID)
	}
	rs.rows[record.ID] = record.Fields
}

// append makes records durable in the open block and returns the key every
// indexed document must carry in `_blk`. Callers pass at most rowBlockSize
// records; a full block is sealed first.
func (rs *rowStore) append(records []templateRecord) (string, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.closed {
		return "", errors.New("row store is closed")
	}
	if len(rs.order) > 0 && len(rs.order)+len(records) > rowBlockSize {
		if err := rs.sealLocked(); err != nil {
			return "", err
		}
	}
	payload, err := encodePlainSegment(templateSegment{Records: records})
	if err != nil {
		return "", err
	}
	frame := make([]byte, rowWALFrameHead, rowWALFrameHead+len(payload))
	binary.BigEndian.PutUint64(frame, rs.open)
	binary.BigEndian.PutUint32(frame[8:], uint32(len(payload)))
	frame = append(frame, payload...)
	if _, err := rs.wal.Write(frame); err != nil {
		return "", err
	}
	if err := syncWAL(rs.wal); err != nil {
		return "", err
	}
	rs.walLen += int64(len(frame))
	rs.frames = append(rs.frames, payload)
	for _, record := range records {
		rs.remember(record)
	}
	return rowBlockKey(rs.day, rs.open), nil
}

// sealLocked writes the open block as an immutable file. A block filled by
// one append is already encoded in its WAL frame and is written as is.
func (rs *rowStore) sealLocked() error {
	if len(rs.order) == 0 {
		return nil
	}
	records := make([]templateRecord, 0, len(rs.order))
	for _, id := range rs.order {
		records = append(records, templateRecord{ID: id, Fields: rs.rows[id]})
	}
	var data []byte
	if len(rs.frames) == 1 {
		data = rs.frames[0]
	} else {
		// Plain Zstandard: the template search costs about as much CPU as
		// the rest of sealing and saves only a few percent of the row bytes,
		// which are themselves a small share of a compact shard.
		var err error
		if data, err = encodePlainSegment(templateSegment{Records: records}); err != nil {
			return err
		}
	}
	if err := writeFileFast(rs.dir, sealedBlockName(rs.open, len(records)), data); err != nil {
		return err
	}
	rs.sealed[rs.open] = len(records)
	rs.cache.put(rs, rs.open, blockRows(records))
	rs.open++
	rs.rows = map[string]map[string]interface{}{}
	rs.order = nil
	rs.frames = nil
	if rs.walLen >= rowWALCheckpoint {
		return rs.checkpointLocked()
	}
	return nil
}

// checkpointLocked makes every sealed block durable with one full sync and
// empties the WAL. It runs only when the open block is empty, so the WAL
// holds nothing that is not in a block.
func (rs *rowStore) checkpointLocked() error {
	if len(rs.order) != 0 {
		return nil
	}
	// On macOS F_FULLFSYNC flushes the drive's whole write cache, covering
	// the blocks' earlier fsyncs; elsewhere those fsyncs were already durable.
	if err := syncTemplateDir(rs.dir); err != nil {
		return err
	}
	if err := rs.wal.Truncate(0); err != nil {
		return err
	}
	if _, err := rs.wal.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := rs.wal.Sync(); err != nil {
		return err
	}
	rs.walLen = 0
	return nil
}

func blockRows(records []templateRecord) map[string]map[string]interface{} {
	rows := make(map[string]map[string]interface{}, len(records))
	for _, record := range records {
		rows[record.ID] = record.Fields
	}
	return rows
}

// writeFileFast publishes name in dir with write, fsync, rename and a
// directory fsync using fsync(2), not F_FULLFSYNC: a process crash leaves
// either nothing or the whole file, and the WAL covers a power loss until
// the next checkpoint.
func writeFileFast(dir, name string, data []byte) error {
	f, err := os.CreateTemp(dir, ".block-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := syncWAL(f); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		return err
	}
	return syncDirFast(dir)
}

// block returns the rows of one block keyed by ID. The open block is served
// from memory; sealed blocks go through the shared decoded-block cache.
func (rs *rowStore) block(block uint64) (map[string]map[string]interface{}, error) {
	rs.mu.Lock()
	if block == rs.open {
		defer rs.mu.Unlock()
		// The open block keeps growing; hand out a snapshot.
		rows := make(map[string]map[string]interface{}, len(rs.rows))
		for id, row := range rs.rows {
			rows[id] = row
		}
		return rows, nil
	}
	count, ok := rs.sealed[block]
	rs.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("row block %s is missing", rowBlockKey(rs.day, block))
	}
	if rows, ok := rs.cache.get(rs, block); ok {
		return rows, nil
	}
	data, err := os.ReadFile(filepath.Join(rs.dir, sealedBlockName(block, count)))
	if err != nil {
		return nil, err
	}
	segment, err := decodeTemplateSegment(data)
	if err != nil {
		return nil, fmt.Errorf("row block %s: %w", rowBlockKey(rs.day, block), err)
	}
	rows := blockRows(segment.Records)
	rs.cache.put(rs, block, rows)
	return rows, nil
}

// row returns a copy-free view of one stored row; callers must not mutate it.
func (rs *rowStore) row(block uint64, id string) (map[string]interface{}, error) {
	rs.mu.Lock()
	if block == rs.open {
		row := rs.rows[id]
		rs.mu.Unlock()
		return row, nil
	}
	rs.mu.Unlock()
	rows, err := rs.block(block)
	if err != nil {
		return nil, err
	}
	return rows[id], nil
}

// sealedBlocks lists sealed blocks with their written row counts.
func (rs *rowStore) sealedBlocks() map[uint64]int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := make(map[uint64]int, len(rs.sealed))
	for block, rows := range rs.sealed {
		out[block] = rows
	}
	return out
}

// dropBlock removes a sealed block that no indexed document references.
func (rs *rowStore) dropBlock(block uint64) error {
	rs.mu.Lock()
	count, ok := rs.sealed[block]
	if !ok {
		rs.mu.Unlock()
		return nil
	}
	delete(rs.sealed, block)
	rs.mu.Unlock()
	rs.cache.remove(rs, block)
	if err := os.Remove(filepath.Join(rs.dir, sealedBlockName(block, count))); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncTemplateDir(rs.dir)
}

// seal flushes the open block, used when a day goes quiet or storage closes.
func (rs *rowStore) seal() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.closed {
		return nil
	}
	if err := rs.sealLocked(); err != nil {
		return err
	}
	return rs.checkpointLocked()
}

// close seals the open block so the next open starts with an empty WAL.
func (rs *rowStore) close() error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.closed {
		return nil
	}
	err := rs.sealLocked()
	if err == nil {
		err = rs.checkpointLocked()
	}
	rs.closed = true
	rs.cache.forget(rs)
	return errors.Join(err, rs.wal.Close())
}

// discard releases the WAL without sealing, for a shard about to be removed.
func (rs *rowStore) discard() {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.closed {
		return
	}
	rs.closed = true
	rs.cache.forget(rs)
	_ = rs.wal.Close()
}

// rowBlockCache is a small LRU of decoded sealed blocks shared by all days.
type rowBlockCache struct {
	mu    sync.Mutex
	limit int
	ll    *list.List
	items map[rowCacheKey]*list.Element
}

type rowCacheKey struct {
	store *rowStore
	block uint64
}

type rowCacheEntry struct {
	key  rowCacheKey
	rows map[string]map[string]interface{}
}

func newRowBlockCache(limit int) *rowBlockCache {
	return &rowBlockCache{limit: limit, ll: list.New(), items: map[rowCacheKey]*list.Element{}}
}

func (c *rowBlockCache) get(rs *rowStore, block uint64) (map[string]map[string]interface{}, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[rowCacheKey{rs, block}]; ok {
		c.ll.MoveToFront(el)
		return el.Value.(*rowCacheEntry).rows, true
	}
	return nil, false
}

func (c *rowBlockCache) put(rs *rowStore, block uint64, rows map[string]map[string]interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := rowCacheKey{rs, block}
	if el, ok := c.items[key]; ok {
		el.Value.(*rowCacheEntry).rows = rows
		c.ll.MoveToFront(el)
		return
	}
	c.items[key] = c.ll.PushFront(&rowCacheEntry{key: key, rows: rows})
	for c.ll.Len() > c.limit {
		oldest := c.ll.Back()
		c.ll.Remove(oldest)
		delete(c.items, oldest.Value.(*rowCacheEntry).key)
	}
}

func (c *rowBlockCache) remove(rs *rowStore, block uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[rowCacheKey{rs, block}]; ok {
		c.ll.Remove(el)
		delete(c.items, rowCacheKey{rs, block})
	}
}

func (c *rowBlockCache) forget(rs *rowStore) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, el := range c.items {
		if key.store == rs {
			c.ll.Remove(el)
			delete(c.items, key)
		}
	}
}

// sortedBlocks returns block numbers in ascending order.
func sortedBlocks(blocks map[uint64]int) []uint64 {
	out := make([]uint64, 0, len(blocks))
	for block := range blocks {
		out = append(out, block)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
