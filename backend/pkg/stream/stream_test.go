package stream

import (
	"strings"
	"testing"
	"time"
)

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
