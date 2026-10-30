package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type approvalEvents struct {
	discardAgentEvents
	ids chan string
}

func (e approvalEvents) ApprovalRequired(id, tool string, input map[string]any, reason string) {
	e.ids <- id
}

func postApproval(t *testing.T, h *Services, body string) int {
	t.Helper()
	w := httptest.NewRecorder()
	h.HandleAgentApprove(w, httptest.NewRequest(http.MethodPost, "/api/v1/agent/approve", bytes.NewBufferString(body)))
	return w.Code
}

func approvalID(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case id := <-ch:
		if len(id) < 32 {
			t.Fatalf("short capability: %q", id)
		}
		return id
	case <-time.After(time.Second):
		t.Fatal("approval event not sent")
		return ""
	}
}

func TestAgentApprovalOneCallAndReplay(t *testing.T) {
	h := &Services{}
	events := approvalEvents{ids: make(chan string, 1)}
	result := make(chan error, 1)
	go func() {
		result <- h.awaitAgentApproval(context.Background(), events, "ingest_local", map[string]any{"path": "/tmp/a"}, "")
	}()
	id := approvalID(t, events.ids)
	if got := postApproval(t, h, `{"id":"wrong","approve":true}`); got != http.StatusNotFound {
		t.Fatalf("spoof status %d", got)
	}
	select {
	case <-result:
		t.Fatal("spoof approved pending call")
	default:
	}
	if got := postApproval(t, h, `{"id":"`+id+`","approve":true}`); got != http.StatusOK {
		t.Fatalf("approve status %d", got)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if got := postApproval(t, h, `{"id":"`+id+`","approve":true}`); got != http.StatusNotFound {
		t.Fatalf("replay status %d", got)
	}
}

func TestAgentApprovalDenyAndNoImplicitApproval(t *testing.T) {
	h := &Services{}
	events := approvalEvents{ids: make(chan string, 1)}
	result := make(chan error, 1)
	go func() {
		result <- h.awaitAgentApproval(context.Background(), events, "mcp__tickets__create", map[string]any{}, "")
	}()
	id := approvalID(t, events.ids)
	if got := postApproval(t, h, `{"id":"`+id+`","approve":false}`); got != http.StatusOK {
		t.Fatalf("deny status %d", got)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("denial error %v", err)
	}
	if err := h.awaitAgentApproval(context.Background(), discardAgentEvents{}, "mcp__tickets__create", nil, ""); err == nil {
		t.Fatal("nonstream sensitive tool implicitly approved")
	}
}

func TestAgentApprovalCancelledAndTimedOut(t *testing.T) {
	h := &Services{}
	events := approvalEvents{ids: make(chan string, 2)}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- h.awaitAgentApproval(ctx, events, "ingest_remote", nil, "") }()
	id := approvalID(t, events.ids)
	cancel()
	if err := <-result; err == nil {
		t.Fatal("cancelled approval succeeded")
	}
	if got := postApproval(t, h, `{"id":"`+id+`","approve":true}`); got != http.StatusNotFound {
		t.Fatalf("cancelled status %d", got)
	}

	short, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer stop()
	go func() { result <- h.awaitAgentApproval(short, events, "ingest_remote", nil, "") }()
	id = approvalID(t, events.ids)
	if err := <-result; err == nil {
		t.Fatal("expired approval succeeded")
	}
	if got := postApproval(t, h, `{"id":"`+id+`","approve":true}`); got != http.StatusNotFound {
		t.Fatalf("expired status %d", got)
	}
}

func TestAgentApprovalRejectsConcurrentReplay(t *testing.T) {
	h := &Services{}
	events := approvalEvents{ids: make(chan string, 1)}
	result := make(chan error, 1)
	go func() { result <- h.awaitAgentApproval(context.Background(), events, "ingest_cloudwatch", nil, "") }()
	id := approvalID(t, events.ids)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); statuses <- postApproval(t, h, `{"id":"`+id+`","approve":true}`) }()
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusNotFound] != 1 {
		t.Fatalf("statuses %v", counts)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestAgentApprovalClassification(t *testing.T) {
	for name, sensitive := range map[string]bool{"save_view": false, "mcp__s__read": true, "query_logs": false, "ui_get_state": false, "ui_show_view": false, "ui_unknown": true, "ui_save_workspace": false, "ui_list_workspaces": false, "ui_get_workspace": false, "ui_set_viewer_options": false} {
		if got := agentToolNeedsApproval(name, nil, ""); got != sensitive {
			t.Errorf("%s sensitive=%v want %v", name, got, sensitive)
		}
	}
}

// Imports the user named run without a prompt; anything the model chose
// (for example from log text) still needs approval.
func TestAgentApprovalImportsNamedByUser(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	user := "Import ~/logs/app.log and https://example.com/a.log, then pull /aws/lambda/orders.\nAlso ~/Downloads/ and ~/var.\n"
	for _, c := range []struct {
		tool, key, arg string
		prompt         bool
	}{
		{"ingest_local", "path", "~/logs/app.log", false},
		{"ingest_local", "path", filepath.Join(home, "logs/app.log"), false},
		{"ingest_local", "path", "logs/app.log", false},
		{"ingest_local", "path", "~/logs", true},
		{"ingest_local", "path", "~/Downloads", false},
		{"ingest_local", "path", "~/Downloads/", false},
		{"ingest_local", "path", "~/var/", false},
		{"ingest_local", "path", "~/var/x", true},
		{"ingest_local", "path", "~/.aws/credentials", true},
		{"ingest_local", "path", "", true},
		{"ingest_remote", "url", "https://example.com/a.log", false},
		{"ingest_remote", "url", "https://example.com/a.log?leak=secret", true},
		{"ingest_remote", "url", "https://example.com", true},
		{"ingest_cloudwatch", "log_group", "/aws/lambda/orders", false},
		{"ingest_cloudwatch", "log_group", "/aws/lambda/order", true},
	} {
		if got := agentToolNeedsApproval(c.tool, map[string]any{c.key: c.arg}, user); got != c.prompt {
			t.Errorf("%s %q prompt=%v want %v", c.tool, c.arg, got, c.prompt)
		}
	}
	if runtime.GOOS != "linux" {
		if agentToolNeedsApproval("ingest_local", map[string]any{"path": "~/Logs/App.log"}, user) {
			t.Error("case-insensitive file system: ~/Logs/App.log is the path the user named")
		}
	}
	if runtime.GOOS == "windows" {
		winUser := `Import C:\Logs\App.log and ~\Reports\.`
		for arg, prompt := range map[string]bool{`c:\logs\app.log`: false, `C:/Logs/App.log`: false, filepath.Join(home, "reports"): false, `C:\Logs\other.log`: true} {
			if got := agentToolNeedsApproval("ingest_local", map[string]any{"path": arg}, winUser); got != prompt {
				t.Errorf("windows %q prompt=%v want %v", arg, got, prompt)
			}
		}
	}
	msgs := []agentMessage{{Role: "user", Content: "import /var/log/a.log"}, {Role: "assistant", Content: "import /var/log/b.log"}, {Role: "user", Content: []any{map[string]any{"type": "tool_result", "content": "/var/log/c.log"}}}}
	text := agentUserText(msgs)
	if !agentArgNamed("/var/log/a.log", text) || agentArgNamed("/var/log/b.log", text) || agentArgNamed("/var/log/c.log", text) {
		t.Fatalf("user text %q", text)
	}
}

func TestAgentApprovalRejectsInvalidRequest(t *testing.T) {
	h := &Services{}
	for _, body := range []string{`{}`, `{"id":"x"}`, `{"id":"x","approve":false,"feedback":"no"}`, `{"id":"x","approve":false,"approve_all":true}`, `{"id":"x","approve":false,"approve_all":false}`, `{"id":"x","approve":false,"other":1}`} {
		if got := postApproval(t, h, body); got != http.StatusBadRequest {
			t.Fatalf("%s status %d", body, got)
		}
	}
}

func TestAgentApprovalAllCoversLaterCallsOnlyInSameStream(t *testing.T) {
	h := &Services{}
	ctx := withAgentApprovalPolicy(context.Background(), false)
	events := approvalEvents{ids: make(chan string, 2)}
	result := make(chan error, 1)
	go func() { result <- h.awaitAgentApproval(ctx, events, "ingest_local", nil, "") }()
	id := approvalID(t, events.ids)
	if got := postApproval(t, h, `{"id":"`+id+`","approve":true,"approve_all":true}`); got != http.StatusOK {
		t.Fatalf("approve all status %d", got)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := h.awaitAgentApproval(ctx, events, "mcp__tickets__read", nil, ""); err != nil {
		t.Fatalf("later call: %v", err)
	}
	select {
	case id := <-events.ids:
		t.Fatalf("later call prompted again: %s", id)
	default:
	}

	other := withAgentApprovalPolicy(context.Background(), false)
	go func() { result <- h.awaitAgentApproval(other, events, "mcp__tickets__read", nil, "") }()
	id = approvalID(t, events.ids)
	if got := postApproval(t, h, `{"id":"`+id+`","approve":false}`); got != http.StatusOK {
		t.Fatalf("other policy status %d", got)
	}
	if err := <-result; err == nil {
		t.Fatal("other policy inherited approval")
	}
}

func TestAgentApprovalAllRequiresStreamingClientPolicy(t *testing.T) {
	h := &Services{}
	ctx := withAgentApprovalPolicy(context.Background(), true)
	if err := h.awaitAgentApproval(ctx, discardAgentEvents{}, "mcp__tickets__read", nil, ""); err == nil {
		t.Fatal("nonstream request bypassed approval")
	}
	events := approvalEvents{ids: make(chan string, 1)}
	if err := h.awaitAgentApproval(ctx, events, "mcp__tickets__read", nil, ""); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-events.ids:
		t.Fatalf("opted-in stream prompted: %s", id)
	default:
	}
}
