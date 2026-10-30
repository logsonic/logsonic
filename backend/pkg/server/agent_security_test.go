package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgentLoopbackOnlyHostAndOriginBoundary(t *testing.T) {
	tests := []struct {
		name       string
		host       string
		remoteAddr string
		origin     string
		fetchSite  string
		wantStatus int
	}{
		{name: "same origin production", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", origin: "http://localhost:8080", wantStatus: http.StatusNoContent},
		{name: "split localhost dev ports", host: "localhost:8080", remoteAddr: "[::1]:1234", origin: "http://localhost:5173", wantStatus: http.StatusNoContent},
		{name: "loopback IP dev origin", host: "127.0.0.1:8080", remoteAddr: "127.0.0.1:1234", origin: "http://127.0.0.1:5173", wantStatus: http.StatusNoContent},
		{name: "origin absent", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", wantStatus: http.StatusNoContent},
		{name: "cross-site fetch without origin", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", fetchSite: "cross-site", wantStatus: http.StatusForbidden},
		{name: "cross-site fetch with loopback origin", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", origin: "http://localhost:5173", fetchSite: "cross-site", wantStatus: http.StatusForbidden},
		{name: "same-site fetch", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", fetchSite: "same-site", wantStatus: http.StatusNoContent},
		{name: "same-origin fetch", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", fetchSite: "same-origin", wantStatus: http.StatusNoContent},
		{name: "browser navigation fetch", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", fetchSite: "none", wantStatus: http.StatusNoContent},
		{name: "remote client", host: "localhost:8080", remoteAddr: "192.0.2.10:1234", wantStatus: http.StatusForbidden},
		{name: "attacker host DNS rebinding", host: "attacker.example:8080", remoteAddr: "127.0.0.1:1234", origin: "http://localhost:5173", wantStatus: http.StatusForbidden},
		{name: "missing host", remoteAddr: "127.0.0.1:1234", origin: "http://localhost:5173", wantStatus: http.StatusForbidden},
		{name: "foreign site origin", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", origin: "https://attacker.example", wantStatus: http.StatusForbidden},
		{name: "null origin", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", origin: "null", wantStatus: http.StatusForbidden},
		{name: "origin with credentials", host: "localhost:8080", remoteAddr: "127.0.0.1:1234", origin: "http://localhost@attacker.example", wantStatus: http.StatusForbidden},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/api/v1/agent/status", nil)
			req.Host = tc.host
			req.RemoteAddr = tc.remoteAddr
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.fetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			}
			w := httptest.NewRecorder()
			agentLoopbackOnly(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tc.wantStatus)
			}
		})
	}
}
