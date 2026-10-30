package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
)

const agentMaxPendingApprovals = 64

type agentApprovalDecision struct {
	approve    bool
	approveAll bool
}

type agentApprovalPolicyKey struct{}

type agentApprovalPolicy struct{ all atomic.Bool }

// Policy lives only in one streaming chat request's context. Later HTTP
// requests must opt in again; nothing is stored on Services or on disk.
func withAgentApprovalPolicy(ctx context.Context, approveAll bool) context.Context {
	policy := &agentApprovalPolicy{}
	policy.all.Store(approveAll)
	return context.WithValue(ctx, agentApprovalPolicyKey{}, policy)
}

type agentApprovalRegistry struct {
	mu      sync.Mutex
	pending map[string]chan agentApprovalDecision
}

type agentApprovalEvents interface {
	ApprovalRequired(id, tool string, input map[string]any, reason string)
}

var agentSafeUITools = map[string]bool{
	"ui_get_state": true, "ui_navigate": true, "ui_show_view": true,
	"ui_set_query": true, "ui_set_time": true, "ui_set_sources": true,
	"ui_set_columns": true, "ui_set_column_widths": true,
	"ui_add_filter": true, "ui_remove_filter": true, "ui_clear_filters": true,
	"ui_set_sort": true, "ui_set_page": true, "ui_fields_panel": true,
	"ui_sidebar": true, "ui_open_workspace": true, "ui_run_search": true,
	"ui_list_workspaces": true, "ui_get_workspace": true, "ui_set_viewer_options": true,
	"ui_save_workspace": true,
}

// agentToolNeedsApproval gates what prompt injection could abuse: imports the
// user did not name and every external MCP call (their arguments leave the
// machine). Searches, viewer changes and saved views are local and run freely.
// userText is the user's own messages in this request, never tool output.
func agentToolNeedsApproval(name string, input map[string]any, userText string) bool {
	switch name {
	case "list_sources", "query_logs", "analyze_logs", "facet_logs", "log_histogram", "log_context", "compare_windows", "log_patterns", "save_view":
		return false
	case "ingest_local":
		return !agentPathNamed(toolString(input, "path"), userText)
	case "ingest_remote":
		return !agentArgNamed(toolString(input, "url"), userText)
	case "ingest_cloudwatch":
		return !agentArgNamed(toolString(input, "log_group"), userText)
	}
	return !agentSafeUITools[name]
}

// agentArgNamed reports whether arg appears in userText as a whole token, so
// "a" or a prefix of a URL the user wrote does not count.
func agentArgNamed(arg, userText string) bool {
	if arg == "" {
		return false
	}
	for from := 0; ; {
		i := strings.Index(userText[from:], arg)
		if i < 0 {
			return false
		}
		start, end := from+i, from+i+len(arg)
		if (start == 0 || strings.ContainsRune(" \t\n\"'`(<[", rune(userText[start-1]))) &&
			(end == len(userText) || strings.ContainsRune(" \t\n\"'`)>],.;:!?", rune(userText[end]))) {
			return true
		}
		from = start + 1
	}
}

// The model may expand "~/x" or drop it, either side may add a trailing
// separator to a folder, and Windows paths accept either separator, so a
// path also counts as named in those forms.
func agentPathNamed(arg, userText string) bool {
	candidates := []string{arg}
	if abs, err := agentExpandPath(arg); err == nil {
		candidates = append(candidates, abs)
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if rel, err := filepath.Rel(home, abs); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				candidates = append(candidates, "~"+string(filepath.Separator)+rel)
			}
		}
	}
	// macOS and Windows file systems ignore case by default. This only decides
	// whether to prompt; agentSecretPath already ignores case.
	fold := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	if fold {
		userText = strings.ToLower(userText)
	}
	for _, c := range candidates {
		if fold {
			c = strings.ToLower(c)
		}
		for _, form := range []string{c, filepath.ToSlash(c)} {
			form = strings.TrimRight(form, `/\`)
			if form != "" && (agentArgNamed(form, userText) || agentArgNamed(form+"/", userText) || agentArgNamed(form+`\`, userText)) {
				return true
			}
		}
	}
	return false
}

func agentUserText(messages []agentMessage) string {
	var b strings.Builder
	for _, m := range messages {
		if text, ok := m.Content.(string); ok && m.Role == "user" {
			b.WriteString(text)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func agentApprovalReason(name string) string {
	switch name {
	case "ingest_local":
		return "Import a local path you did not name"
	case "ingest_remote":
		return "Download a URL you did not name"
	case "ingest_cloudwatch":
		return "Import a CloudWatch log group you did not name"
	default:
		return "Send data to an external tool"
	}
}

// awaitAgentApproval holds the exact call in the agent loop. Only the local
// browser receives the capability; it is never included in model messages.
func (h *Services) awaitAgentApproval(ctx context.Context, events agentEvents, name string, input map[string]any, userText string) error {
	if !agentToolNeedsApproval(name, input, userText) {
		return ctx.Err()
	}
	e, ok := events.(agentApprovalEvents)
	if !ok {
		return errors.New("tool requires a streaming approval request")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	policy, _ := ctx.Value(agentApprovalPolicyKey{}).(*agentApprovalPolicy)
	if policy != nil && policy.all.Load() {
		return nil
	}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return errors.New("could not create approval capability")
	}
	id := hex.EncodeToString(raw[:])
	decision := make(chan agentApprovalDecision, 1)
	r := &h.agentApprovals
	r.mu.Lock()
	if r.pending == nil {
		r.pending = make(map[string]chan agentApprovalDecision)
	}
	if len(r.pending) >= agentMaxPendingApprovals {
		r.mu.Unlock()
		return errors.New("too many pending tool approvals")
	}
	r.pending[id] = decision
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()
	e.ApprovalRequired(id, name, input, agentApprovalReason(name))
	// The wait is bounded by the chat request's own deadline.
	select {
	case d := <-decision:
		if err := ctx.Err(); err != nil {
			return err
		}
		if !d.approve {
			return errors.New("the user denied this tool call; do not retry it unless the user asks again in a new message")
		}
		if d.approveAll && policy != nil {
			policy.all.Store(true)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// HandleAgentApprove consumes one capability exactly once. A missing, used or
// cancelled capability has the same 404 response.
func (h *Services) HandleAgentApprove(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	req.Body = http.MaxBytesReader(w, req.Body, 4096)
	var body struct {
		ID         string `json:"id"`
		Approve    *bool  `json:"approve"`
		ApproveAll *bool  `json:"approve_all"`
	}
	dec := json.NewDecoder(req.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "invalid approval request", http.StatusBadRequest)
		return
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF || body.ID == "" || body.Approve == nil || (body.ApproveAll != nil && !*body.Approve) {
		http.Error(w, "invalid approval request", http.StatusBadRequest)
		return
	}
	r := &h.agentApprovals
	r.mu.Lock()
	decision, exists := r.pending[body.ID]
	delete(r.pending, body.ID)
	r.mu.Unlock()
	if !exists {
		http.Error(w, "approval not found", http.StatusNotFound)
		return
	}
	decision <- agentApprovalDecision{approve: *body.Approve, approveAll: body.ApproveAll != nil && *body.ApproveAll}
	status := "denied"
	if *body.Approve {
		status = "approved"
	}
	json.NewEncoder(w).Encode(map[string]string{"status": status})
}

func (s *agentSSE) ApprovalRequired(id, tool string, input map[string]any, reason string) {
	s.send("approval_required", map[string]any{"id": id, "tool": tool, "input": input, "reason": reason})
}
