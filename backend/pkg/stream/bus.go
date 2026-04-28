package stream

import (
	"fmt"
	"sync"
	"sync/atomic"

	"logsonic/pkg/tokenizer"
	"logsonic/pkg/types"
)

const (
	defaultSubBufSize = 1000
	DefaultBufSize    = 50_000
	ReplayCount       = 500
)

// Event is a parsed log event published to the stream bus.
type Event struct {
	Fields map[string]interface{}
}

// Subscriber receives events from the bus.
type Subscriber struct {
	id          int
	Ch          chan *Event
	AlertCh     chan AlertFire
	filterQuery string // Bleve-style field:value query; empty = no filter
}

// Bus is a thread-safe ring-buffer pub/sub bus for log stream events.
// It keeps the last DefaultBufSize events for replay on new subscriber connect.
type Bus struct {
	mu       sync.Mutex
	subs     map[int]*Subscriber
	nextID   int
	closed   bool
	count    atomic.Int64
	ringBuf  []*Event
	ringHead int
	ringSize int

	tokMu     sync.RWMutex
	streamTok tokenizer.TokenizerInterface // nil = no re-tokenization

	alerts alertState
}

// NewBus creates a new stream bus with a 50k-event ring buffer.
func NewBus() *Bus {
	return &Bus{
		subs:    make(map[int]*Subscriber),
		ringBuf: make([]*Event, DefaultBufSize),
	}
}

// SetStreamTokenizer replaces the bus-level GROK tokenizer applied before publishing.
// Pass nil to disable re-tokenization. Tok must be pre-configured with the desired pattern.
func (b *Bus) SetStreamTokenizer(tok tokenizer.TokenizerInterface) {
	b.tokMu.Lock()
	defer b.tokMu.Unlock()
	b.streamTok = tok
}

// SetSubscriberFilter updates the per-subscriber filter query.
// Empty query clears the filter (all events pass).
func (b *Bus) SetSubscriberFilter(sub *Subscriber, query string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s, ok := b.subs[sub.id]; ok {
		s.filterQuery = query
	}
}

// Subscribe registers a new subscriber and returns it along with a replay of
// the last ReplayCount events (oldest-first). Registration and snapshot are
// atomic: no events are missed or duplicated. bufSize ≤ 0 uses the default.
func (b *Bus) Subscribe(bufSize int) (*Subscriber, []*Event) {
	if bufSize <= 0 {
		bufSize = defaultSubBufSize
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.nextID
	b.nextID++
	sub := &Subscriber{id: id, Ch: make(chan *Event, bufSize), AlertCh: make(chan AlertFire, 64)}
	b.subs[id] = sub
	return sub, b.replayLocked()
}

// Unsubscribe removes a subscriber and closes its channels.
func (b *Bus) Unsubscribe(sub *Subscriber) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.subs[sub.id]; ok {
		delete(b.subs, sub.id)
		close(sub.Ch)
		close(sub.AlertCh)
	}
}

// Publish applies the bus-level GROK tokenizer (if configured), stores the event
// in the ring buffer, then fans out to subscribers that pass their filter.
// Slow subscribers are dropped rather than blocking the publisher.
func (b *Bus) Publish(e *Event) {
	// Apply GROK outside the main lock — parsing can take non-trivial time.
	b.tokMu.RLock()
	tok := b.streamTok
	b.tokMu.RUnlock()
	if tok != nil {
		e = applyGROK(tok, e)
	}

	// Snapshot alert rules outside the main lock.
	b.alerts.mu.RLock()
	rules := b.alerts.rules
	b.alerts.mu.RUnlock()

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.count.Add(1)
	b.ringBuf[b.ringHead] = e
	b.ringHead = (b.ringHead + 1) % len(b.ringBuf)
	if b.ringSize < len(b.ringBuf) {
		b.ringSize++
	}
	for _, sub := range b.subs {
		if sub.filterQuery != "" && !matchFilter(e.Fields, sub.filterQuery) {
			continue
		}
		select {
		case sub.Ch <- e:
		default:
		}
	}
	// Evaluate alert rules; fan-out fires to all subscribers.
	for _, rule := range rules {
		if !rule.Enabled || !matchFilter(e.Fields, rule.Query) {
			continue
		}
		fire := AlertFire{Rule: rule, Entry: e.Fields}
		for _, sub := range b.subs {
			select {
			case sub.AlertCh <- fire:
			default:
			}
		}
	}
}

// Close shuts down the bus and closes all subscriber channels.
func (b *Bus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for _, sub := range b.subs {
		close(sub.Ch)
		close(sub.AlertCh)
	}
	b.subs = make(map[int]*Subscriber)
}

// Count returns the total number of events published since bus creation.
func (b *Bus) Count() int64 {
	return b.count.Load()
}

// SubscriberCount returns the number of active subscribers.
func (b *Bus) SubscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

func (b *Bus) replayLocked() []*Event {
	n := b.ringSize
	if n > ReplayCount {
		n = ReplayCount
	}
	if n == 0 {
		return nil
	}
	out := make([]*Event, n)
	start := (b.ringHead - n + len(b.ringBuf)) % len(b.ringBuf)
	for i := 0; i < n; i++ {
		out[i] = b.ringBuf[(start+i)%len(b.ringBuf)]
	}
	return out
}

// applyGROK re-parses the event's _raw field using tok and merges the result.
// Returns the original event unchanged if _raw is absent or parsing fails.
func applyGROK(tok tokenizer.TokenizerInterface, e *Event) *Event {
	raw, ok := e.Fields["_raw"]
	if !ok {
		return e
	}
	rawStr, ok := raw.(string)
	if !ok || rawStr == "" {
		return e
	}
	src := ""
	if v, ok := e.Fields["_src"]; ok {
		src = fmt.Sprintf("%v", v)
	}
	opts := types.IngestSessionOptions{
		Source:       src,
		SmartDecoder: false,
	}
	parsed, _, _, err := tok.ParseLogs([]string{rawStr}, opts)
	if err != nil || len(parsed) == 0 {
		return e
	}
	// Merge: original fields first, then parsed (parsed wins for non-meta keys).
	newFields := make(map[string]interface{}, len(e.Fields)+len(parsed[0]))
	for k, v := range e.Fields {
		newFields[k] = v
	}
	for k, v := range parsed[0] {
		newFields[k] = v
	}
	return &Event{Fields: newFields}
}
