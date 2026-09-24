package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"logsonic/pkg/types"
)

// ingestLines stores lines through the real ingest endpoints (start → logs →
// end) so the test exercises the same path a client does, including the
// message field the DEFAULT_PATTERN produces.
func ingestLines(t *testing.T, ts *httptest.Server, lines []string) {
	t.Helper()
	post := func(path string, body any) map[string]any {
		b, _ := json.Marshal(body)
		resp, err := http.Post(ts.URL+path, "application/json", bytes.NewReader(b))
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("POST %s: status %d body %v", path, resp.StatusCode, out)
		}
		return out
	}
	start := post("/api/v1/ingest/start", map[string]any{
		"name":    "DEFAULT_PATTERN",
		"pattern": "%{GREEDYDATA:message}",
		"source":  "pct.log",
	})
	sid, _ := start["session_id"].(string)
	if sid == "" {
		t.Fatalf("no session_id in %v", start)
	}
	post("/api/v1/ingest/logs", map[string]any{"logs": lines, "session_id": sid})
	post("/api/v1/ingest/end", map[string]any{"session_id": sid})
}

// searchQuery issues GET /api/v1/logs with the query encoded exactly the way
// a browser's URLSearchParams (or Go's url.Values) encodes it, over a date
// range wide enough to include rows stamped with ingest time.
func searchQuery(t *testing.T, ts *httptest.Server, query string) types.LogResponse {
	t.Helper()
	params := url.Values{}
	params.Set("query", query)
	params.Set("limit", "10")
	params.Set("start_date", "2000-01-01T00:00:00Z")
	params.Set("end_date", "2100-01-01T00:00:00Z")
	resp, err := http.Get(ts.URL + "/api/v1/logs?" + params.Encode())
	if err != nil {
		t.Fatalf("GET logs: %v", err)
	}
	defer resp.Body.Close()
	var out types.LogResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode logs: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET logs query=%q: status %d (%s)", query, resp.StatusCode, out.Status)
	}
	return out
}

// TestQueryWithPercentIsNotDoubleDecoded is the regression test for the
// now-07 defect: the storage layer used to url.PathUnescape a query string
// that net/http had already decoded, so message:"100%" became an "invalid URL
// escape" error (surfaced as HTTP 500) and a literal %20 silently turned into
// a space.
func TestQueryWithPercentIsNotDoubleDecoded(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	ingestLines(t, ts, []string{
		"disk usage at 100% on /dev/sda1",
		"literal a%20b token here",
		"unrelated line",
	})

	cases := []struct {
		query   string
		wantHit string
	}{
		{`message:"100%"`, "100%"},
		{`100%`, "100%"},
		{`message:"a%20b"`, "a%20b"},
	}
	for _, tc := range cases {
		out := searchQuery(t, ts, tc.query)
		if out.Query != tc.query {
			t.Errorf("query=%q: echoed query %q was altered", tc.query, out.Query)
		}
		if out.TotalCount < 1 {
			t.Errorf("query=%q: expected at least one hit, got %d", tc.query, out.TotalCount)
			continue
		}
		found := false
		for _, row := range out.Logs {
			if msg, _ := row["message"].(string); strings.Contains(msg, tc.wantHit) {
				found = true
			}
		}
		if !found {
			t.Errorf("query=%q: no returned row contains %q", tc.query, tc.wantHit)
		}
	}
}
