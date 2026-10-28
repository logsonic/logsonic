package server

import (
	"net"
	"net/http"
	"net/url"
)

// Agent tools can read local paths and named AWS profiles. Keep that ability
// confined to local callers even if the rest of LogSonic serves a LAN.
func agentLoopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			http.Error(w, "agent routes require loopback", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Scheme != "http" || u.User != nil || !isLoopbackHost(u.Hostname()) {
				http.Error(w, "foreign origin forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
