package stream

import (
	"sync"
	"sync/atomic"
)

const defaultSubBufSize = 1000

// Event is a parsed log event published to the stream bus.
type Event struct {
	Fields map[string]interface{}
}

// Subscriber receives events from the bus.
type Subscriber struct {
	id int
	Ch chan *Event
}

// Bus is a simple fan-out pub/sub bus for log stream events.
type Bus struct {
	mu     sync.RWMutex
	subs   map[int]*Subscriber
	nextID int
	closed bool
	count  atomic.Int64
}

// NewBus creates a new stream bus.
func NewBus() *Bus {
	return &Bus{subs: make(map[int]*Subscriber)}
}

// Subscribe registers a new subscriber. bufSize ≤ 0 uses the default.
func (b *Bus) Subscribe(bufSize int) *Subscriber {
	if bufSize <= 0 {
		bufSize = defaultSubBufSize
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.nextID
	b.nextID++
	sub := &Subscriber{id: id, Ch: make(chan *Event, bufSize)}
	b.subs[id] = sub
	return sub
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

// Publish broadcasts an event to all subscribers. Drops events for slow subscribers.
func (b *Bus) Publish(e *Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		return
	}
	b.count.Add(1)
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
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
