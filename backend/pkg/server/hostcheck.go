package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"logsonic/pkg/types"
)

// loopbackHostnames is the fixed allow-list used whenever the server binds a
// loopback address. It always includes both the IPv4 and IPv6 forms because
// browsers and CLI tools disagree about which one they resolve "localhost"
// to on a given machine.
var loopbackHostnames = []string{"localhost", "127.0.0.1", "::1"}

// isLoopbackHost reports whether cfg.Host (as configured, before DNS
// resolution) is one of the canonical loopback forms. Anything else —
// including a loopback IP outside 127.0.0.1 such as 127.0.0.2, or a hostname
// that merely happens to resolve to loopback — is treated as non-loopback,
// so it only gets Host-header protection when the operator opts in via
// -allowed-hosts.
func isLoopbackHost(host string) bool {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "", "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

// allowedHosts computes the Host allow-list for cfg and whether it should be
// enforced at all.
//
// Loopback binds (the default, the app, `-open`) are always enforced against
// the fixed loopback set: this is what closes the DNS-rebinding gap, where a
// page on an attacker-controlled domain that resolves to 127.0.0.1 would
// otherwise be served same-origin by the browser and could read the API.
//
// Non-loopback binds (`-host 0.0.0.0`, a specific LAN IP; the Docker image
// sets HOST=0.0.0.0) cannot use the fixed set — a browser on the LAN sends
// `Host: myserver:8080`, and a container-mapped hostname the server has no
// way to resolve to its own interfaces. Enforcement there is opt-in via
// cfg.AllowedHosts (-allowed-hosts / LOGSONIC_ALLOWED_HOSTS), so Docker and
// existing LAN deployments keep working unchanged unless the operator
// explicitly hardens them.
func allowedHosts(cfg Config) (hosts map[string]struct{}, enforce bool) {
	if isLoopbackHost(cfg.Host) {
		return hostnameSet(loopbackHostnames), true
	}
	if len(cfg.AllowedHosts) == 0 {
		return nil, false
	}
	all := make([]string, 0, len(loopbackHostnames)+len(cfg.AllowedHosts))
	all = append(all, loopbackHostnames...)
	all = append(all, cfg.AllowedHosts...)
	return hostnameSet(all), true
}

func hostnameSet(hosts []string) map[string]struct{} {
	set := make(map[string]struct{}, len(hosts))
	for _, h := range hosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			set[h] = struct{}{}
		}
	}
	return set
}

// requestHostname extracts the lowercased hostname portion of an inbound
// request's Host header, stripping an optional port. r.Host may take the
// forms "host", "host:port", "[::1]", or "[::1]:port" — net.SplitHostPort
// handles the port-bearing forms; the portless IPv6-bracket form is
// unwrapped by hand since SplitHostPort requires a port to parse at all.
func requestHostname(r *http.Request) string {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	} else {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	return strings.ToLower(host)
}

// hostAllowlistMiddleware rejects any request whose Host header does not
// resolve (after stripping the port) to an entry in hosts. Rejections return
// HTTP 421 Misdirected Request, mirroring how a reverse proxy signals "this
// server does not serve that name" — a normal 403/404 would look like an
// application-level error rather than a routing mismatch. See
// specs/now-09-loopback-security.md.
func hostAllowlistMiddleware(hosts map[string]struct{}) func(http.Handler) http.Handler {
	var mu sync.Mutex
	var lastLogged time.Time

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := hosts[requestHostname(r)]; ok {
				next.ServeHTTP(w, r)
				return
			}

			// Rejections are logged at most once a minute — a rebinding probe
			// or a misconfigured LAN client can otherwise flood the server log
			// with an identical line on every request.
			mu.Lock()
			shouldLog := time.Since(lastLogged) >= time.Minute
			if shouldLog {
				lastLogged = time.Now()
			}
			mu.Unlock()
			if shouldLog {
				fmt.Fprintf(os.Stderr, "security: rejected request with disallowed Host header %q (further rejections in the next minute are not logged individually)\n", r.Host)
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusMisdirectedRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status: "error",
				Error:  "Request Host header is not on the allowed list",
				Code:   "HOST_NOT_ALLOWED",
			})
		})
	}
}
