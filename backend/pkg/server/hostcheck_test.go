package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// newTestServer builds a server bound to a loopback host (the default
// enforcement path) and returns it plus an httptest server wrapping its
// router, cleaned up automatically.
func newTestServer(t *testing.T, cfg Config) (*Server, *httptest.Server) {
	t.Helper()
	if cfg.StoragePath == "" {
		cfg.StoragePath = t.TempDir()
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 5 * time.Second
	}
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { _ = srv.services.CloseStorage() })
	ts := httptest.NewServer(srv.router)
	t.Cleanup(ts.Close)
	return srv, ts
}

// requestWithHost issues method to ts's router with the given Host header
// value substituted for the one httptest would otherwise set. Go's client
// dials the httptest listener's real address but sends req.Host verbatim as
// the Host header, which is exactly what a rebinding attack would forge.
func requestWithHost(t *testing.T, ts *httptest.Server, method, path, host string, body *strings.Reader) *http.Response {
	t.Helper()
	var reqBody *strings.Reader
	if body != nil {
		reqBody = body
	} else {
		reqBody = strings.NewReader("")
	}
	req, err := http.NewRequest(method, ts.URL+path, reqBody)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s (Host=%q): %v", method, path, host, err)
	}
	return resp
}

// hostFromTestURL returns the loopback "host:port" httptest.Server actually
// listens on, e.g. "127.0.0.1:54321".
func hostFromTestURL(ts *httptest.Server) string {
	return strings.TrimPrefix(ts.URL, "http://")
}

func TestHostAllowlistLoopbackAccepts(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	cases := []string{
		"localhost",
		"localhost:8080",
		hostFromTestURL(ts), // 127.0.0.1:<real port>
		"127.0.0.1",
		"[::1]:8080",
		"::1",
	}
	for _, host := range cases {
		resp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", host, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("Host=%q: expected 200, got %d", host, resp.StatusCode)
		}
	}
}

func TestHostAllowlistLoopbackRejects(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	cases := []string{
		"evil.example",
		"evil.example:8080",
		"127.0.0.1.evil.example",
	}
	for _, host := range cases {
		resp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", host, nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusMisdirectedRequest {
			t.Errorf("Host=%q: expected 421, got %d", host, resp.StatusCode)
		}
		var errResp types.ErrorResponse
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errResp.Code != "HOST_NOT_ALLOWED" {
			t.Errorf("Host=%q: expected code HOST_NOT_ALLOWED, got %q", host, errResp.Code)
		}
	}
}

func TestHostAllowlistProtectsMCPAndSPA(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	// A bad Host must be rejected before it ever reaches the MCP handler or
	// the SPA catch-all -- both are mounted after the allow-list middleware.
	for _, path := range []string{"/mcp", "/", "/some/spa/route"} {
		resp := requestWithHost(t, ts, http.MethodGet, path, "evil.example", nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusMisdirectedRequest {
			t.Errorf("path=%q: expected 421 for a disallowed Host, got %d", path, resp.StatusCode)
		}
	}

	// And a good Host must still reach them (not itself asserting 200, since
	// /mcp's own protocol semantics aren't this test's concern -- only that
	// it isn't blocked by the allow-list).
	for _, path := range []string{"/", "/some/spa/route"} {
		resp := requestWithHost(t, ts, http.MethodGet, path, "localhost", nil)
		resp.Body.Close()
		if resp.StatusCode == http.StatusMisdirectedRequest {
			t.Errorf("path=%q: unexpected 421 for an allowed Host", path)
		}
	}
}

func TestHostAllowlistNonLoopbackDefaultsToOpen(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "0.0.0.0", Port: ":0"})

	// With no -allowed-hosts, a non-loopback bind must not enforce the
	// check at all -- Docker (HOST=0.0.0.0) and existing LAN deployments
	// must keep working unchanged.
	for _, host := range []string{hostFromTestURL(ts), "myserver:8080", "evil.example"} {
		resp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", host, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("Host=%q: expected 200 (check disabled), got %d", host, resp.StatusCode)
		}
	}
}

func TestHostAllowlistNonLoopbackOptIn(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "0.0.0.0", Port: ":0", AllowedHosts: []string{"myserver"}})

	ok := []string{"myserver:8080", "myserver", "localhost"}
	for _, host := range ok {
		resp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", host, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("Host=%q: expected 200, got %d", host, resp.StatusCode)
		}
	}

	resp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", "evil.example", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("Host=evil.example: expected 421, got %d", resp.StatusCode)
	}
}

func TestContentSecurityPolicyOnHTMLOnly(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	resp := requestWithHost(t, ts, http.MethodGet, "/", "localhost", nil)
	defer resp.Body.Close()
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'self'") {
		t.Errorf("expected CSP header on /, got %q", csp)
	}
	// The native shell fetches blob: (download hook) URLs from the page;
	// 'self' does not cover that scheme. Verified in Chrome: connect-src
	// 'self' alone refuses a blob: fetch. logsonicfile: was removed with the
	// scheme handler once now-08 switched dock-drops to paths.
	if !strings.Contains(csp, "connect-src 'self' blob:;") {
		t.Errorf("expected connect-src to allow blob: (and nothing else), got %q", csp)
	}
	if strings.Contains(csp, "logsonicfile") {
		t.Errorf("logsonicfile: scheme should no longer be in the CSP, got %q", csp)
	}

	pingResp := requestWithHost(t, ts, http.MethodGet, "/api/v1/ping", "localhost", nil)
	defer pingResp.Body.Close()
	if csp := pingResp.Header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("expected no CSP header on /api/v1/ping, got %q", csp)
	}
}

func TestRequireJSONBodyRejectsFormEncoded(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/workspaces", strings.NewReader("name=x"))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("expected 415, got %d", resp.StatusCode)
	}
}

func TestRequireJSONBodyAcceptsJSONWithCharset(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/workspaces", strings.NewReader(`{"name":"x","time":{"mode":"relative"}}`))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnsupportedMediaType {
		t.Errorf("expected charset-qualified application/json to be accepted, got 415")
	}
}

func TestRequireJSONBodyIgnoresBodylessRequests(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})

	// A body-less DELETE and a body-less POST must never be rejected for
	// their (absent) content type.
	deleteResp := requestWithHost(t, ts, http.MethodDelete, "/api/v1/logs", "localhost", nil)
	defer deleteResp.Body.Close()
	if deleteResp.StatusCode == http.StatusUnsupportedMediaType {
		t.Errorf("body-less DELETE /api/v1/logs: unexpected 415")
	}

	pauseResp := requestWithHost(t, ts, http.MethodPost, "/api/v1/live/subscribers/does-not-exist/pause", "localhost", nil)
	defer pauseResp.Body.Close()
	if pauseResp.StatusCode == http.StatusUnsupportedMediaType {
		t.Errorf("body-less POST live/subscribers/pause: unexpected 415")
	}
}

func TestRequireJSONBodyDoesNotApplyToStdinRoute(t *testing.T) {
	// /live/stdin is registered outside the JSON-only middleware's group
	// (it streams raw lines, not JSON) and must not be rejected for its
	// content type. We only assert it's never a 415; its actual behavior
	// belongs to the live-tail tests.
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/live/stdin", strings.NewReader("a line\n"))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnsupportedMediaType {
		t.Errorf("/live/stdin: unexpected 415 for a non-JSON content type")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	cases := map[string]bool{
		"":            true,
		"localhost":   true,
		"127.0.0.1":   true,
		"::1":         true,
		"0.0.0.0":     false,
		"192.168.1.5": false,
		"myserver":    false,
	}
	for host, want := range cases {
		if got := isLoopbackHost(host); got != want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestRequestHostname(t *testing.T) {
	cases := map[string]string{
		"localhost":              "localhost",
		"localhost:8080":         "localhost",
		"127.0.0.1":              "127.0.0.1",
		"127.0.0.1:8080":         "127.0.0.1",
		"[::1]":                  "::1",
		"[::1]:8080":             "::1",
		"::1":                    "::1",
		"EVIL.example:80":        "evil.example",
		"127.0.0.1.evil.example": "127.0.0.1.evil.example",
	}
	for host, want := range cases {
		r := &http.Request{Host: host}
		if got := requestHostname(r); got != want {
			t.Errorf("requestHostname(Host=%q) = %q, want %q", host, got, want)
		}
	}
}
