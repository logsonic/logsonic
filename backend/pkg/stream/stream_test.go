package stream

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// errTokenizer always returns an error, forcing PipeReader's fallback path.
type errTokenizer struct{}

func (errTokenizer) ParseLogs(_ []string, _ types.IngestSessionOptions) ([]map[string]interface{}, int, int, error) {
	return nil, 0, 0, errors.New("mock error")
}
func (errTokenizer) AddPattern(_ string, _ ...int) error                   { return nil }
func (errTokenizer) AddCustomPattern(_, _ string) error                    { return nil }
func (errTokenizer) AddPersistentPattern(_ string) error                   { return nil }
func (errTokenizer) AddPersistentCustomPattern(_, _ string) error          { return nil }
func (errTokenizer) ClearRequestPatterns()                                  {}
func (errTokenizer) GetPersistentPatterns() []string                       { return nil }
func (errTokenizer) GetCustomPatterns() map[string]string                  { return nil }
func (errTokenizer) GetPatterns() []string                                 { return nil }
func (errTokenizer) ClearPatterns() error                                   { return nil }

func TestBusPubSub(t *testing.T) {
	b := NewBus()
	sub, _ := b.Subscribe(10)

	b.Publish(&Event{Fields: map[string]interface{}{"msg": "hello"}})

	select {
	case ev := <-sub.Ch:
		if ev.Fields["msg"] != "hello" {
			t.Fatalf("expected hello, got %v", ev.Fields["msg"])
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for event")
	}

	b.Unsubscribe(sub)
	if b.Count() != 1 {
		t.Fatalf("expected count 1, got %d", b.Count())
	}
}

func TestBusSlowSubscriberDrop(t *testing.T) {
	b := NewBus()
	sub, _ := b.Subscribe(1) // tiny buffer

	// Publish 3 events — only 1 fits; rest are dropped.
	for i := 0; i < 3; i++ {
		b.Publish(&Event{Fields: map[string]interface{}{"i": i}})
	}

	if b.Count() != 3 {
		t.Fatalf("count should be 3 (published), got %d", b.Count())
	}
	if len(sub.Ch) != 1 {
		t.Fatalf("buffer should hold 1 event, holds %d", len(sub.Ch))
	}
	b.Unsubscribe(sub)
}

func TestParseSyslogRFC3164(t *testing.T) {
	raw := "<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8"
	fields := parseSyslog(raw)

	if fields["_src"] != "syslog" {
		t.Errorf("expected _src=syslog, got %v", fields["_src"])
	}
	if !strings.Contains(fields["message"].(string), "su root") {
		t.Errorf("message missing expected content: %v", fields["message"])
	}
	if fields["facility"].(int) != 4 {
		t.Errorf("facility: expected 4, got %v", fields["facility"])
	}
	if fields["severity"].(int) != 2 {
		t.Errorf("severity: expected 2, got %v", fields["severity"])
	}
}

func TestParseSyslogRFC5424(t *testing.T) {
	raw := `<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3"] An application event log`
	fields := parseSyslog(raw)

	if fields["_src"] != "syslog" {
		t.Errorf("expected _src=syslog, got %v", fields["_src"])
	}
	if !strings.Contains(fields["message"].(string), "application event") {
		t.Errorf("message missing expected content: %v", fields["message"])
	}
	if fields["app_name"] != "evntslog" {
		t.Errorf("app_name: expected evntslog, got %v", fields["app_name"])
	}
	if fields["msg_id"] != "ID47" {
		t.Errorf("msg_id: expected ID47, got %v", fields["msg_id"])
	}
}

func TestParseSyslogFallback(t *testing.T) {
	raw := "not a syslog message at all"
	fields := parseSyslog(raw)

	if fields["_raw"] != raw {
		t.Errorf("fallback: expected raw preserved")
	}
	if fields["_src"] != "syslog" {
		t.Errorf("fallback: expected _src=syslog")
	}
}

func TestMatchFilter(t *testing.T) {
	fields := map[string]interface{}{
		"level":   "error",
		"message": "connection timeout",
		"_raw":    "2024-01-01 level=error connection timeout",
	}

	cases := []struct {
		query string
		want  bool
	}{
		{"", true},
		{"level:error", true},
		{"level:ERROR", true},      // case-insensitive
		{"level:warn", false},
		{"connection", true},       // freetext matches _raw
		{"timeout", true},          // freetext matches message
		{"level:error timeout", true},  // AND
		{"level:error level:warn", false},
		{"level:missing_field", false},
	}

	for _, c := range cases {
		got := matchFilter(fields, c.query)
		if got != c.want {
			t.Errorf("matchFilter(%q) = %v, want %v", c.query, got, c.want)
		}
	}
}

func TestAlertRuleFire(t *testing.T) {
	b := NewBus()
	b.SetAlertRules([]AlertRule{
		{ID: "r1", Name: "Error alert", Query: "level:error", Enabled: true},
	})

	sub, _ := b.Subscribe(10)

	b.Publish(&Event{Fields: map[string]interface{}{"level": "info", "message": "ok"}})
	b.Publish(&Event{Fields: map[string]interface{}{"level": "error", "message": "boom"}})

	// info event on log channel
	select {
	case ev := <-sub.Ch:
		if ev.Fields["level"] != "info" {
			t.Fatalf("expected info log, got %v", ev.Fields["level"])
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for info log event")
	}

	// error event on log channel
	select {
	case ev := <-sub.Ch:
		if ev.Fields["level"] != "error" {
			t.Fatalf("expected error log, got %v", ev.Fields["level"])
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for error log event")
	}

	// alert fire on AlertCh
	select {
	case fire := <-sub.AlertCh:
		if fire.Rule.ID != "r1" {
			t.Fatalf("expected rule r1, got %q", fire.Rule.ID)
		}
		if fire.Entry["level"] != "error" {
			t.Fatalf("expected error entry, got %v", fire.Entry["level"])
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for alert fire")
	}

	b.Unsubscribe(sub)
}

func TestAlertRuleDisabled(t *testing.T) {
	b := NewBus()
	b.SetAlertRules([]AlertRule{
		{ID: "r1", Name: "Error alert", Query: "level:error", Enabled: false},
	})

	sub, _ := b.Subscribe(10)
	b.Publish(&Event{Fields: map[string]interface{}{"level": "error", "message": "boom"}})

	select {
	case fire := <-sub.AlertCh:
		t.Fatalf("disabled rule should not fire, got: %v", fire)
	default:
		// correct — no alert
	}

	b.Unsubscribe(sub)
}

type mockStorage struct {
	batches [][]map[string]interface{}
}

func (m *mockStorage) Store(logs []map[string]interface{}, _ string) error {
	batch := make([]map[string]interface{}, len(logs))
	copy(batch, logs)
	m.batches = append(m.batches, batch)
	return nil
}
func (m *mockStorage) Search(_ string, _, _ *time.Time, _ []string) ([]map[string]interface{}, time.Duration, error) {
	return nil, 0, nil
}
func (m *mockStorage) List() ([]string, error)            { return nil, nil }
func (m *mockStorage) GetSourceNames() ([]string, error)  { return nil, nil }
func (m *mockStorage) Clear() error                       { return nil }
func (m *mockStorage) BaseDir() string                    { return "" }
func (m *mockStorage) GetDocCount(_ string) (uint64, error) { return 0, nil }
func (m *mockStorage) DeleteByIds(_ []string) (int, error) { return 0, nil }

func TestBleveIndexerFlushOnTimer(t *testing.T) {
	b := NewBus()
	store := &mockStorage{}

	idx := NewBleveIndexer(b, store, IndexerConfig{
		FlushInterval: 50 * time.Millisecond,
		BatchSize:     100,
	})
	ctx, cancel := context.WithCancel(context.Background())
	idx.Start(ctx)

	b.Publish(&Event{Fields: map[string]interface{}{"msg": "a"}})
	b.Publish(&Event{Fields: map[string]interface{}{"msg": "b"}})

	// Wait for flush
	time.Sleep(150 * time.Millisecond)
	cancel()
	idx.Stop()

	if len(store.batches) == 0 {
		t.Fatal("expected at least one batch flushed")
	}
	total := 0
	for _, batch := range store.batches {
		total += len(batch)
	}
	if total < 2 {
		t.Fatalf("expected 2 events indexed, got %d", total)
	}
}

func TestBusFilterDelivery(t *testing.T) {
	b := NewBus()
	sub, _ := b.Subscribe(10)
	b.SetSubscriberFilter(sub, "level:error")

	b.Publish(&Event{Fields: map[string]interface{}{"level": "info", "message": "ok"}})
	b.Publish(&Event{Fields: map[string]interface{}{"level": "error", "message": "boom"}})

	// Only the error event should arrive.
	select {
	case ev := <-sub.Ch:
		if ev.Fields["level"] != "error" {
			t.Fatalf("expected error event, got %v", ev.Fields["level"])
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for filtered event")
	}

	select {
	case ev := <-sub.Ch:
		t.Fatalf("unexpected extra event: %v", ev.Fields)
	default:
		// nothing — correct, info event was filtered
	}

	b.Unsubscribe(sub)
}

func TestBusClose(t *testing.T) {
	b := NewBus()
	sub1, _ := b.Subscribe(10)
	sub2, _ := b.Subscribe(10)

	b.Close()

	// Both channels must be closed.
	if _, ok := <-sub1.Ch; ok {
		t.Fatal("sub1.Ch should be closed after Bus.Close()")
	}
	if _, ok := <-sub2.Ch; ok {
		t.Fatal("sub2.Ch should be closed after Bus.Close()")
	}

	// Publish after close must not panic.
	b.Publish(&Event{Fields: map[string]interface{}{"k": "v"}})

	// Double-close must not panic.
	b.Close()
}

func TestBusSubscriberCount(t *testing.T) {
	b := NewBus()
	if n := b.SubscriberCount(); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
	sub1, _ := b.Subscribe(10)
	sub2, _ := b.Subscribe(10)
	if n := b.SubscriberCount(); n != 2 {
		t.Fatalf("expected 2, got %d", n)
	}
	b.Unsubscribe(sub1)
	if n := b.SubscriberCount(); n != 1 {
		t.Fatalf("expected 1, got %d", n)
	}
	b.Unsubscribe(sub2)
	if n := b.SubscriberCount(); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestBusReplay(t *testing.T) {
	b := NewBus()

	total := ReplayCount + 50
	for i := 0; i < total; i++ {
		b.Publish(&Event{Fields: map[string]interface{}{"i": i}})
	}

	_, replay := b.Subscribe(10)
	if len(replay) != ReplayCount {
		t.Fatalf("expected %d replay events, got %d", ReplayCount, len(replay))
	}
	want := total - ReplayCount
	if got := replay[0].Fields["i"].(int); got != want {
		t.Fatalf("replay[0].i = %d, want %d", got, want)
	}
	if got := replay[len(replay)-1].Fields["i"].(int); got != total-1 {
		t.Fatalf("replay[last].i = %d, want %d", got, total-1)
	}
}

func TestBleveIndexerBatchFlush(t *testing.T) {
	b := NewBus()
	store := &mockStorage{}

	batchSize := 5
	idx := NewBleveIndexer(b, store, IndexerConfig{
		FlushInterval: 10 * time.Second,
		BatchSize:     batchSize,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	idx.Start(ctx)

	for i := 0; i < batchSize; i++ {
		b.Publish(&Event{Fields: map[string]interface{}{"n": i}})
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(store.batches) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	if len(store.batches) == 0 {
		t.Fatal("expected batch flush after reaching batchSize")
	}
	total := 0
	for _, batch := range store.batches {
		total += len(batch)
	}
	if total < batchSize {
		t.Fatalf("expected %d events indexed, got %d", batchSize, total)
	}
}

func TestBleveIndexerStopFlushesRemainder(t *testing.T) {
	b := NewBus()
	store := &mockStorage{}

	idx := NewBleveIndexer(b, store, IndexerConfig{
		FlushInterval: 10 * time.Second,
		BatchSize:     100,
	})
	ctx, cancel := context.WithCancel(context.Background())
	idx.Start(ctx)

	b.Publish(&Event{Fields: map[string]interface{}{"x": 1}})
	b.Publish(&Event{Fields: map[string]interface{}{"x": 2}})

	// Give the indexer goroutine time to read both events into its batch
	// before we trigger shutdown. Without this, cancel may race with reads.
	time.Sleep(20 * time.Millisecond)

	cancel()
	idx.Stop()

	total := 0
	for _, batch := range store.batches {
		total += len(batch)
	}
	if total < 2 {
		t.Fatalf("expected 2 events flushed on stop, got %d", total)
	}
}

func TestPipeReader(t *testing.T) {
	b := NewBus()
	sub, _ := b.Subscribe(20)

	r := strings.NewReader("line one\nline two\nline three\n")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		PipeReader(ctx, r, b, errTokenizer{})
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("PipeReader did not finish after EOF")
	}

	// nil tokenizer → fallback path: 3 raw events published.
	if n := len(sub.Ch); n != 3 {
		t.Fatalf("expected 3 events on bus, got %d", n)
	}

	ev := <-sub.Ch
	if ev.Fields["_raw"] != "line one" {
		t.Fatalf("expected _raw='line one', got %v", ev.Fields["_raw"])
	}
	if ev.Fields["_src"] != "stdin" {
		t.Fatalf("expected _src='stdin', got %v", ev.Fields["_src"])
	}
}
