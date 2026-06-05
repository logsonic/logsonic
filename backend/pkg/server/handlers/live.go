package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	storagepkg "logsonic/pkg/storage"
	"logsonic/pkg/timeresolve"
	"logsonic/pkg/types"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

const (
	liveFlushInterval    = 250 * time.Millisecond
	liveHeartbeat        = 20 * time.Second
	liveMaxBatchLines    = 250
	liveSubscriberBuffer = 32
	liveScanMaxLine      = 10 * 1024 * 1024
)

type TailManager struct {
	storage    storagepkg.StorageInterface
	invalidate func()

	mu          sync.RWMutex
	sources     map[string]*TailSource
	subscribers map[string]*liveSubscriber

	rootCtx    context.Context
	rootCancel context.CancelFunc
}

type TailSource struct {
	id      string
	path    string
	opts    types.IngestSessionOptions
	decoder *l2g.Decoder
	manager *TailManager

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	seq *atomic.Int64

	mu            sync.Mutex
	resolver      *timeresolve.Resolver
	syntheticMode bool
	anchor        time.Time
}

type liveSubscriber struct {
	id           string
	sourceFilter string
	ch           chan liveEvent

	mu      sync.Mutex
	paused  bool
	skipped map[string]int
}

type liveEvent struct {
	name string
	data interface{}
}

func NewTailManager(storage storagepkg.StorageInterface, invalidate func()) *TailManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &TailManager{
		storage:     storage,
		invalidate:  invalidate,
		sources:     make(map[string]*TailSource),
		subscribers: make(map[string]*liveSubscriber),
		rootCtx:     ctx,
		rootCancel:  cancel,
	}
}

func (m *TailManager) Start(ctx context.Context) {
	m.mu.Lock()
	m.rootCtx, m.rootCancel = context.WithCancel(ctx)
	m.mu.Unlock()

	go func() {
		<-ctx.Done()
		m.Shutdown()
	}()
}

func (m *TailManager) Shutdown() {
	m.mu.Lock()
	if m.rootCancel != nil {
		m.rootCancel()
	}
	sources := make([]*TailSource, 0, len(m.sources))
	for _, source := range m.sources {
		sources = append(sources, source)
	}
	m.mu.Unlock()

	for _, source := range sources {
		source.Stop()
	}
}

func (m *TailManager) ActiveSourceIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.sources))
	for id := range m.sources {
		ids = append(ids, id)
	}
	return ids
}

func (m *TailManager) StartFile(path string, opts types.IngestSessionOptions) (string, error) {
	if path == "" {
		return "", errors.New("path is required")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("stat path: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory", absPath)
	}
	if opts.Source == "" {
		opts.Source = filepath.Base(absPath)
	}
	mtime := info.ModTime()
	opts.SourceMTime = &mtime

	source, err := m.newSource(opts)
	if err != nil {
		return "", err
	}
	source.path = absPath
	if err := m.addSource(source); err != nil {
		return "", err
	}

	go source.followFile()
	m.publishStatus(source.id, "started", absPath)
	return source.id, nil
}

func (m *TailManager) StartStdin(ctx context.Context, reader io.Reader, opts types.IngestSessionOptions) (string, <-chan struct{}, error) {
	if opts.Source == "" {
		opts.Source = "stdin"
	}
	source, err := m.newSource(opts)
	if err != nil {
		return "", nil, err
	}

	parentCtx := m.currentRootCtx()
	source.ctx, source.cancel = context.WithCancel(parentCtx)
	requestCtx, cancelRequest := context.WithCancel(ctx)
	originalCancel := source.cancel
	source.cancel = func() {
		cancelRequest()
		originalCancel()
	}

	if err := m.addSource(source); err != nil {
		source.cancel()
		return "", nil, err
	}

	go source.readStdin(requestCtx, reader)
	m.publishStatus(source.id, "started", "stdin")
	return source.id, source.done, nil
}

func (m *TailManager) StopSource(sourceID string) bool {
	m.mu.RLock()
	source := m.sources[sourceID]
	m.mu.RUnlock()
	if source == nil {
		return false
	}
	source.Stop()
	return true
}

func (m *TailManager) Subscribe(sourceFilter string) *liveSubscriber {
	sub := &liveSubscriber{
		id:           uuid.New().String(),
		sourceFilter: sourceFilter,
		ch:           make(chan liveEvent, liveSubscriberBuffer),
		skipped:      make(map[string]int),
	}

	m.mu.Lock()
	m.subscribers[sub.id] = sub
	m.mu.Unlock()
	return sub
}

func (m *TailManager) Unsubscribe(subscriberID string) {
	m.mu.Lock()
	delete(m.subscribers, subscriberID)
	m.mu.Unlock()
}

func (m *TailManager) PauseSubscriber(subscriberID string) bool {
	m.mu.RLock()
	sub := m.subscribers[subscriberID]
	m.mu.RUnlock()
	if sub == nil {
		return false
	}
	sub.mu.Lock()
	sub.paused = true
	sub.mu.Unlock()
	return true
}

func (m *TailManager) ResumeSubscriber(subscriberID string) (map[string]int, bool) {
	m.mu.RLock()
	sub := m.subscribers[subscriberID]
	m.mu.RUnlock()
	if sub == nil {
		return nil, false
	}

	sub.mu.Lock()
	sub.paused = false
	skipped := sub.skipped
	sub.skipped = make(map[string]int)
	sub.mu.Unlock()

	for sourceID, count := range skipped {
		if count <= 0 {
			continue
		}
		sub.enqueue(liveEvent{
			name: "skipped",
			data: types.LiveSkippedEvent{SourceID: sourceID, Count: count, Reason: "paused"},
		}, sourceID, 0)
	}
	return skipped, true
}

func (m *TailManager) currentRootCtx() context.Context {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.rootCtx != nil {
		return m.rootCtx
	}
	return context.Background()
}

// Done reports manager shutdown. Long-lived handlers (the SSE stream) select on
// it so they unblock when the server begins draining, rather than waiting out
// the HTTP graceful-shutdown timeout — http.Server.Shutdown does not cancel
// in-flight request contexts, so r.Context() alone never fires on shutdown.
func (m *TailManager) Done() <-chan struct{} {
	return m.currentRootCtx().Done()
}

func (m *TailManager) newSource(opts types.IngestSessionOptions) (*TailSource, error) {
	opts = defaultLiveOptions(opts)
	decoder, err := l2g.NewDecoder(l2g.PatternSpec{
		Name:           opts.Name,
		Grok:           opts.Pattern,
		CustomPatterns: opts.CustomPatterns,
		Priority:       opts.Priority,
	}, l2g.DecoderOptions{
		SmartDecode: opts.SmartDecoder,
	})
	if err != nil {
		return nil, fmt.Errorf("create decoder: %w", err)
	}

	ctx, cancel := context.WithCancel(m.currentRootCtx())
	return &TailSource{
		id:      uuid.New().String(),
		opts:    opts,
		decoder: decoder,
		manager: m,
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		seq:     new(atomic.Int64),
	}, nil
}

func (m *TailManager) addSource(source *TailSource) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sources[source.id]; exists {
		return fmt.Errorf("source %s already exists", source.id)
	}
	m.sources[source.id] = source
	return nil
}

func (m *TailManager) removeSource(sourceID string) {
	m.mu.Lock()
	delete(m.sources, sourceID)
	m.mu.Unlock()
}

func (m *TailManager) publishRows(sourceID string, rows []map[string]interface{}) {
	if len(rows) == 0 {
		return
	}
	event := liveEvent{
		name: "rows",
		data: types.LiveRowsEvent{SourceID: sourceID, Rows: rows},
	}

	m.mu.RLock()
	subscribers := make([]*liveSubscriber, 0, len(m.subscribers))
	for _, sub := range m.subscribers {
		subscribers = append(subscribers, sub)
	}
	m.mu.RUnlock()

	for _, sub := range subscribers {
		if sub.sourceFilter != "" && sub.sourceFilter != sourceID {
			continue
		}
		sub.enqueue(event, sourceID, len(rows))
	}
}

func (m *TailManager) publishStatus(sourceID, status, message string) {
	event := liveEvent{
		name: "source_status",
		data: types.LiveSourceStatusEvent{SourceID: sourceID, Status: status, Message: message},
	}

	m.mu.RLock()
	subscribers := make([]*liveSubscriber, 0, len(m.subscribers))
	for _, sub := range m.subscribers {
		subscribers = append(subscribers, sub)
	}
	m.mu.RUnlock()

	for _, sub := range subscribers {
		if sub.sourceFilter != "" && sub.sourceFilter != sourceID {
			continue
		}
		sub.enqueue(event, sourceID, 0)
	}
}

func (s *liveSubscriber) enqueue(event liveEvent, sourceID string, rowCount int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.paused {
		if rowCount > 0 {
			s.skipped[sourceID] += rowCount
		}
		return
	}

	select {
	case s.ch <- event:
	default:
		if rowCount > 0 {
			s.skipped[sourceID] += rowCount
		}
	}
}

func (s *TailSource) Stop() {
	s.cancel()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
	}
}

func (s *TailSource) finish(status, message string) {
	s.manager.removeSource(s.id)
	s.manager.publishStatus(s.id, status, message)
	close(s.done)
}

func (s *TailSource) followFile() {
	defer func() {
		if r := recover(); r != nil {
			s.finish("error", fmt.Sprintf("panic: %v", r))
		}
	}()

	file, info, err := openTailFile(s.path)
	if err != nil {
		s.finish("error", err.Error())
		return
	}
	defer file.Close()

	offset, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		s.finish("error", err.Error())
		return
	}

	var pending []byte
	buf := make([]byte, 32*1024)
	ticker := time.NewTicker(liveFlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			s.finish("stopped", "source stopped")
			return
		case <-ticker.C:
			if rotated, nextInfo := fileChanged(s.path, info, offset); rotated {
				file.Close()
				file, info, err = openExistingTailFile(s.path)
				if err != nil {
					s.finish("error", err.Error())
					return
				}
				offset = 0
				if nextInfo != nil {
					info = nextInfo
				}
				pending = pending[:0]
			}

			for {
				n, readErr := file.Read(buf)
				if n > 0 {
					offset += int64(n)
					pending = append(pending, buf[:n]...)
					lines, rest := splitCompleteLines(pending)
					pending = rest
					if err := s.processLines(lines); err != nil {
						s.finish("error", err.Error())
						return
					}
				}
				if readErr == nil {
					continue
				}
				if errors.Is(readErr, io.EOF) {
					break
				}
				s.finish("error", readErr.Error())
				return
			}
		}
	}
}

func (s *TailSource) readStdin(ctx context.Context, reader io.Reader) {
	defer func() {
		if r := recover(); r != nil {
			s.finish("error", fmt.Sprintf("panic: %v", r))
		}
	}()

	lines := make(chan string)
	errCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 64*1024), liveScanMaxLine)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				errCh <- ctx.Err()
				close(lines)
				return
			}
		}
		errCh <- scanner.Err()
		close(lines)
	}()

	var batch []string
	ticker := time.NewTicker(liveFlushInterval)
	defer ticker.Stop()
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		err := s.processLines(batch)
		batch = nil
		if err != nil {
			s.finish("error", err.Error())
			return false
		}
		return true
	}

	for {
		select {
		case <-s.ctx.Done():
			s.finish("stopped", "source stopped")
			return
		case <-ctx.Done():
			if !flush() {
				return
			}
			s.finish("stopped", "client disconnected")
			return
		case line, ok := <-lines:
			if !ok {
				if !flush() {
					return
				}
				if err := <-errCh; err != nil && !errors.Is(err, context.Canceled) {
					s.finish("error", err.Error())
				} else {
					s.finish("stopped", "stdin closed")
				}
				return
			}
			batch = append(batch, line)
			if len(batch) >= liveMaxBatchLines && !flush() {
				return
			}
		case <-ticker.C:
			if !flush() {
				return
			}
		}
	}
}

func (s *TailSource) processLines(lines []string) error {
	if len(lines) == 0 {
		return nil
	}

	results := s.decoder.Decode(lines)

	s.mu.Lock()
	if s.resolver == nil {
		resolution, inference := buildResolution(results, s.opts)
		s.resolver = timeresolve.New(resolution)
		s.syntheticMode, s.anchor = syntheticTimestampSettings(inference, resolution)
	}
	parsed, _, _ := postProcessWithResolver(results, s.opts, s.resolver, s.seq, s.syntheticMode, s.anchor)
	s.mu.Unlock()

	if len(parsed) == 0 {
		return nil
	}

	ids, err := s.manager.storage.StoreWithIDs(parsed, s.opts.Source)
	if err != nil {
		return err
	}
	if s.manager.invalidate != nil {
		s.manager.invalidate()
	}

	for i := range parsed {
		if i < len(ids) {
			parsed[i]["_id"] = ids[i]
		} else {
			parsed[i]["_id"] = storagepkg.BuildDocID(parsed[i], s.opts.Source, i)
		}
		delete(parsed[i], "_seq")
	}
	s.manager.publishRows(s.id, parsed)
	return nil
}

func openTailFile(path string) (*os.File, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, info, nil
}

func openExistingTailFile(path string) (*os.File, os.FileInfo, error) {
	for i := 0; i < 20; i++ {
		file, info, err := openTailFile(path)
		if err == nil {
			return file, info, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, nil, fmt.Errorf("failed to reopen rotated file %s", path)
}

func fileChanged(path string, current os.FileInfo, offset int64) (bool, os.FileInfo) {
	next, err := os.Stat(path)
	if err != nil {
		return false, nil
	}
	if next.Size() < offset {
		return true, next
	}
	if current != nil && !os.SameFile(current, next) {
		return true, next
	}
	return false, next
}

func splitCompleteLines(buf []byte) ([]string, []byte) {
	if len(buf) == 0 {
		return nil, buf
	}
	parts := bytes.Split(buf, []byte{'\n'})
	if len(parts) == 1 {
		return nil, buf
	}
	lines := make([]string, 0, len(parts)-1)
	for _, part := range parts[:len(parts)-1] {
		lines = append(lines, strings.TrimRight(string(part), "\r"))
	}
	rest := append([]byte(nil), parts[len(parts)-1]...)
	return lines, rest
}

func defaultLiveOptions(opts types.IngestSessionOptions) types.IngestSessionOptions {
	if opts.Name == "" && opts.Pattern == "" {
		opts.Name = DefaultPatternName
		opts.Pattern = DefaultPattern
	}
	if opts.Source == "" {
		opts.Source = "live"
	}
	return opts
}

func (h *Services) StartLive(ctx context.Context) {
	if h.Live != nil {
		h.Live.Start(ctx)
	}
}

func (h *Services) HandleLiveEvents(w http.ResponseWriter, r *http.Request) {
	if h.Live == nil {
		http.Error(w, "live manager not initialized", http.StatusInternalServerError)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sourceID := r.URL.Query().Get("source_id")
	sub := h.Live.Subscribe(sourceID)
	defer h.Live.Unsubscribe(sub.id)

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")

	writeSSE(w, "hello", types.LiveHelloEvent{
		SubscriberID: sub.id,
		SourceIDs:    h.Live.ActiveSourceIDs(),
	})
	flusher.Flush()

	heartbeat := time.NewTicker(liveHeartbeat)
	defer heartbeat.Stop()

	managerDone := h.Live.Done()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-managerDone:
			// Server is draining; close the stream so graceful shutdown
			// doesn't block on this held-open connection.
			return
		case event := <-sub.ch:
			if err := writeSSE(w, event.name, event.data); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Services) HandleLiveFileStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Method not allowed", Code: "METHOD_NOT_ALLOWED"})
		return
	}

	var req types.LiveFileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid request body", Code: "INVALID_REQUEST", Details: err.Error()})
		return
	}

	sourceID, err := h.Live.StartFile(req.Path, req.Options)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "error", Error: err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "started", SourceID: sourceID})
}

func (h *Services) HandleLiveStdin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Method not allowed", Code: "METHOD_NOT_ALLOWED"})
		return
	}

	opts, err := liveOptionsFromHeader(r.Header.Get("X-Logsonic-Live-Options"))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid live options", Code: "INVALID_REQUEST", Details: err.Error()})
		return
	}

	sourceID, done, err := h.Live.StartStdin(r.Context(), r.Body, opts)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "error", Error: err.Error()})
		return
	}

	select {
	case <-done:
	case <-r.Context().Done():
	}
	_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "stopped", SourceID: sourceID})
}

func (h *Services) HandleLivePause(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := chi.URLParam(r, "subscriberID")
	if id == "" || !h.Live.PauseSubscriber(id) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(types.LiveControlResponse{Status: "error", Error: "subscriber not found"})
		return
	}
	_ = json.NewEncoder(w).Encode(types.LiveControlResponse{Status: "paused", SubscriberID: id})
}

func (h *Services) HandleLiveResume(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := chi.URLParam(r, "subscriberID")
	skipped, ok := h.Live.ResumeSubscriber(id)
	if id == "" || !ok {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(types.LiveControlResponse{Status: "error", Error: "subscriber not found"})
		return
	}
	_ = json.NewEncoder(w).Encode(types.LiveControlResponse{Status: "resumed", SubscriberID: id, Skipped: skipped})
}

func (h *Services) HandleLiveSourceStop(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := chi.URLParam(r, "sourceID")
	if id == "" || !h.Live.StopSource(id) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "error", Error: "source not found"})
		return
	}
	_ = json.NewEncoder(w).Encode(types.LiveSourceResponse{Status: "stopped", SourceID: id})
}

func writeSSE(w io.Writer, event string, data interface{}) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
		return err
	}
	return nil
}

func liveOptionsFromHeader(encoded string) (types.IngestSessionOptions, error) {
	var opts types.IngestSessionOptions
	if strings.TrimSpace(encoded) == "" {
		return defaultLiveOptions(opts), nil
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return opts, err
	}
	if err := json.Unmarshal(raw, &opts); err != nil {
		return opts, err
	}
	return defaultLiveOptions(opts), nil
}
