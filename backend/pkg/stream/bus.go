package stream

import (
	"sync"
	"sync/atomic"
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
	id int
	Ch chan *Event
}

// Bus is a thread-safe ring-buffer pub/sub bus for log stream events.
// It keeps the last DefaultBufSize events for replay on new subscriber connect.
type Bus struct {
	mu      sync.Mutex
	subs    map[int]*Subscriber
	nextID  int
	closed  bool
	count   atomic.Int64
	ringBuf []*Event
	ringHead int
	ringSize int
}

// NewBus creates a new stream bus with a 50k-event ring buffer.
func NewBus() *Bus {
	return &Bus{
		subs:    make(map[int]*Subscriber),
		ringBuf: make([]*Event, DefaultBufSize),
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
	sub := &Subscriber{id: id, Ch: make(chan *Event, bufSize)}
	b.subs[id] = sub
	return sub, b.replayLocked()
}

// Unsubscribe removes a subscriber and closes its channel.
func (b *Bus) Unsubscribe(sub *Subscriber) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.subs[sub.id]; ok {
		delete(b.subs, sub.id)
		close(sub.Ch)
	}
}

// Publish writes e to the ring buffer and fans out to all subscribers.
// Slow subscribers are dropped rather than blocking the publisher.
func (b *Bus) Publish(e *Event) {
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
		select {
		case sub.Ch <- e:
		default:
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
