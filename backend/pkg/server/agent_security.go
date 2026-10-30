package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Agent tools can read local paths and named AWS profiles. Keep that ability
// confined to local callers even if the rest of LogSonic serves a LAN.
func agentLoopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestHost := requestHostname(r)
		if requestHost == "" || !isLoopbackHost(requestHost) {
			http.Error(w, "agent routes require a loopback host", http.StatusForbidden)
			return
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			http.Error(w, "agent routes require loopback", http.StatusForbidden)
			return
		}
		if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
			http.Error(w, "cross-site request forbidden", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil ||
				u.Opaque != "" || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
				!isLoopbackHost(u.Hostname()) {
				http.Error(w, "foreign origin forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
