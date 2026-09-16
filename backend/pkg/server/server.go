package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"logsonic/docs"
	lsmcp "logsonic/pkg/mcp"
	"logsonic/pkg/server/handlers"
	"logsonic/pkg/types"

	"logsonic/pkg/appconfig"
	"logsonic/pkg/static"
	"logsonic/pkg/storage"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
	httpSwagger "github.com/swaggo/http-swagger"
)

// contentSecurityPolicy is applied only to the HTML document response (the
// SPA shell), not to JSON/SSE responses, which have no script/style
// execution context for CSP to constrain. It makes the "no network calls"
// promise browser-enforced: the SPA's own build emits no inline scripts
// (verified against the Vite output), so script-src 'self' costs nothing and
// blocks any future accidental third-party script tag outright.
//
// connect-src deliberately lists one non-http scheme. 'self' does NOT
// cover it (CSP matches 'self' by scheme+origin, and a blob: URL has a
// different scheme), and it is fetched by the app itself: the macOS shell's
// download hook (LogsonicApp.swift, blobDownloadHookJS) does
// fetch(anchor.href) on the export blob to hand it to NSSavePanel. Verified
// in Chrome: without blob: here the fetch is refused with
// violatedDirective=connect-src. (A second scheme, logsonicfile:, was
// listed here until now-08 replaced the shell's byte handoff with paths;
// the scheme handler was deleted with it.)
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

// @title LogSonic API
// @version 1.0
// @description API for ingesting, storing, and querying log data with Grok pattern support
// @host localhost:8080
// @BasePath /api/v1

type Config struct {
	Port        string
	StoragePath string
	Timeout     time.Duration
	Host        string

	// OpenBrowser opens the web UI in the default browser once the server is
	// listening. AutoPort makes Start scan upward from Port for a free port
	// instead of failing when it is busy. It is enabled by default in main.go.
	OpenBrowser bool
	AutoPort    bool

	// RetentionDays deletes indexed logs older than N days on startup and once
	// a day thereafter. 0 disables retention (keep everything).
	RetentionDays int

	// AllowedHosts extends the Host-header allow-list beyond the fixed
	// loopback set (localhost/127.0.0.1/::1). It only matters when Host is
	// non-loopback (e.g. "0.0.0.0"): there, the allow-list is enforced only
	// if this is non-empty, so LAN and Docker deployments keep working
	// unchanged unless the operator opts in. See hostcheck.go.
	AllowedHosts []string

	// Version, Commit, BuildDate identify the binary (goreleaser ldflags;
	// "dev" / "" for local builds). Exposed on /api/v1/info so the UI can
	// show the server's version rather than its own bundle's, which makes an
	// app-vs-CLI mismatch visible.
	Version   string
	Commit    string
	BuildDate string
}

type Server struct {
	router     chi.Router
	services   *handlers.Services
	store      storage.StorageInterface
	config     Config
	mcpBaseURL atomic.Value
}

// NewServer initializes a new Server instance
func NewServer(cfg Config) (*Server, error) {
	// Initialize Swagger docs
	docs.SwaggerInfo.Title = "LogSonic API"
	docs.SwaggerInfo.Description = "LogSonic API for ingesting, storing, and querying log data with Grok pattern support"
	docs.SwaggerInfo.Version = "1.0"
	docs.SwaggerInfo.Host = cfg.Host + cfg.Port
	docs.SwaggerInfo.BasePath = "/api/v1"
	docs.SwaggerInfo.Schemes = []string{"http"}

	store, err := storage.NewStorage(cfg.StoragePath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize storage: %w", err)
	}

	// Externalize the grok pattern catalog under <storage>/log2grok. LoadConfig
	// seeds the dir from the embedded defaults on first run and reuses it on
	// subsequent boots. We anchor it to the storage dir (not the working
	// directory) so it lives in a stable, writable location — the .app launches
	// with cwd "/", where a relative .log2grok could not be created.
	if err := l2g.LoadConfig(filepath.Join(cfg.StoragePath, "log2grok"), os.Stderr); err != nil {
		return nil, fmt.Errorf("failed to initialize log2grok config: %w", err)
	}
	// Initialize router with middleware
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// middleware.RealIP is deliberately not used: it rewrites RemoteAddr from
	// X-Forwarded-For / X-Real-IP whether or not a trusted proxy set them
	// (GHSA-3fxj-6jh8-hvhx), and this server has no proxy in front of it —
	// nothing here reads RemoteAddr except the request logger.
	// Skip logging for ping route
	r.Use(middleware.WithValue("skipper", func(r *http.Request) bool {
		return r.URL.Path == "/api/v1/ping"
	}))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			skipper, _ := r.Context().Value("skipper").(func(*http.Request) bool)
			if skipper != nil && skipper(r) {
				next.ServeHTTP(w, r)
				return
			}
			middleware.Logger(next).ServeHTTP(w, r)
		})
	})
	r.Use(middleware.Recoverer)

	// Add security headers middleware
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("X-XSS-Protection", "1; mode=block")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			next.ServeHTTP(w, r)
		})
	})

	// Add CORS middleware
	r.Use(cors.Handler(cors.Options{
		// Restrict to localhost origins only instead of wildcard "*"
		AllowedOrigins:   []string{"http://localhost:*", "http://127.0.0.1:*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token", "X-Logsonic-Live-Options"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300, // Maximum value not ignored by any of major browsers
	}))

	// Host-header allow-list. CORS above only stops a cross-origin fetch;
	// it does nothing against DNS rebinding, where a page on an
	// attacker-controlled domain that resolves to 127.0.0.1 is loaded
	// same-origin and can call the API directly. Mounted before MCP, the
	// live routes, the API group, and the SPA catch-all so every one of
	// them is protected. See hostcheck.go.
	if hosts, enforce := allowedHosts(cfg); enforce {
		r.Use(hostAllowlistMiddleware(hosts))
	} else if !isLoopbackHost(cfg.Host) {
		fmt.Fprintf(os.Stderr, "security: binding to non-loopback host %q with no -allowed-hosts configured — Host header checking is disabled; pass -allowed-hosts to enable it\n", cfg.Host)
	}

	// Initialize handler
	h := handlers.NewHandler(store, cfg.StoragePath)
	h.Build = handlers.BuildInfo{Version: cfg.Version, Commit: cfg.Commit, BuildDate: cfg.BuildDate}
	// Retention: <storage>/config.json (set from the UI) overrides the CLI
	// flag / env value main.go resolved into cfg.RetentionDays.
	appCfg, err := appconfig.Open(cfg.StoragePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "appconfig: %v; retention settings cannot be saved this run\n", err)
	}
	handlers.NewRetentionManager(h, appCfg, cfg.RetentionDays)
	srv := &Server{
		services: h,
		store:    store,
		config:   cfg,
	}
	mcpFallbackBaseURL := fmt.Sprintf("http://%s%s", cfg.Host, cfg.Port)
	srv.mcpBaseURL.Store(mcpFallbackBaseURL)

	// Serve static files from embedded filesystem
	embeddedFS := static.GetFileSystem()
	fileServer := http.FileServer(embeddedFS)

	// Create a no-redirect file server wrapper
	noRedirectFileServer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Make a clean path that doesn't end with /
		path := r.URL.Path
		if len(path) > 0 && path[len(path)-1] == '/' && path != "/" {
			path = path[:len(path)-1]
			r.URL.Path = path
		}
		fileServer.ServeHTTP(w, r)
	})

	// Helper function to serve static files with proper MIME types
	serveWithMimeType := func(w http.ResponseWriter, r *http.Request) {
		// Set appropriate content types for common file extensions
		path := r.URL.Path
		ext := filepath.Ext(path)

		// Explicitly set content types before serving the file
		switch ext {
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case ".js":
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		case ".png":
			w.Header().Set("Content-Type", "image/png")
		case ".jpg", ".jpeg":
			w.Header().Set("Content-Type", "image/jpeg")
		case ".svg":
			w.Header().Set("Content-Type", "image/svg+xml")
		case ".ico":
			w.Header().Set("Content-Type", "image/x-icon")
		case ".json":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
		case ".woff":
			w.Header().Set("Content-Type", "font/woff")
		case ".woff2":
			w.Header().Set("Content-Type", "font/woff2")
		case ".ttf":
			w.Header().Set("Content-Type", "font/ttf")
		}

		// Serve index.html for the root path or for client-side routing paths without file extensions
		if path == "/" || path == "" || (ext == "" && !strings.HasPrefix(path, "/api/")) {
			// Handle SPA routing by serving index.html from embedded filesystem
			indexFile, err := embeddedFS.Open("index.html")
			if err != nil {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
			defer indexFile.Close()

			// Read the index.html content
			stat, err := indexFile.Stat()
			if err != nil {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}

			indexData := make([]byte, stat.Size())
			_, err = indexFile.Read(indexData)
			if err != nil {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}

			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
			w.Write(indexData)
			return
		}

		// For all other paths, serve the file from the non-redirecting file server
		noRedirectFileServer.ServeHTTP(w, r)
	}

	// MCP HTTP transport — Streamable HTTP (MCP spec 2025-03-26).
	// Clients connect at /mcp; config is just: {"url": "http://localhost:PORT/mcp"}.
	// Tool calls resolve the local API base URL at request time so AutoPort can
	// update it after Start binds the actual port.
	r.Mount("/mcp", lsmcp.HandlerWithBaseURLProvider(func() string {
		if v, ok := srv.mcpBaseURL.Load().(string); ok && v != "" {
			return v
		}
		return mcpFallbackBaseURL
	}))

	// Long-lived live-tail routes must stay outside the normal API timeout and
	// throttle middleware. They still receive request IDs, logging, recovery,
	// security headers, and CORS from the root router.
	r.Get("/api/v1/live/events", h.HandleLiveEvents)
	r.Post("/api/v1/live/stdin", h.HandleLiveStdin)
	// Per-source delete (spec now-10) is synchronous by contract — it
	// returns the rows removed — and a multi-million-row source takes longer
	// than the API timeout; a timeout mid-way would leave a half-deleted
	// source. No body, so the JSON-body rule the group enforces is moot.
	r.Delete("/api/v1/sources/{name}", h.HandleDeleteSource)

	// Set up API routes
	r.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(cfg.Timeout))
		r.Use(middleware.ThrottleBacklog(10, 50, 5*time.Second))
		// Reject a POST/PUT/PATCH that carries a body in anything but JSON —
		// the classic cross-site vector is a form-encoded POST, which a
		// browser can send cross-origin without a CORS preflight. Scoped to
		// this group only, so /live/stdin and /live/events (registered
		// directly on the root router above, outside this group) are
		// unaffected.
		r.Use(requireJSONBody)
		r.Route("/api/v1", func(r chi.Router) {
			// Swagger UI endpoint
			r.Get("/swagger/*", httpSwagger.Handler(
				httpSwagger.URL("doc.json"),
				httpSwagger.DeepLinking(true),
				httpSwagger.DocExpansion("none"),
				httpSwagger.DomID("swagger-ui"),
			))

			// Ping endpoint for health checks
			r.Get("/ping", h.HandlePing)

			// Ingest API endpoints
			r.Post("/ingest/logs", h.HandleIngest)
			r.Post("/ingest/start", h.HandleIngestStart)
			r.Post("/ingest/end", h.HandleIngestEnd)
			// Path-based ingest (spec now-08). The route itself returns in
			// milliseconds (202, job accepted) so — unlike /live/stdin and
			// /live/events above — it belongs in the normal timeout group;
			// the read runs on its own goroutine past this request's return.
			r.Post("/ingest/file", h.HandleIngestFile)
			r.Get("/ingest/jobs", h.HandleListIngestJobs)
			r.Delete("/ingest/jobs/{id}", h.HandleCancelIngestJob)

			// Parse endpoints
			r.Post("/parse", h.HandleParse)
			r.Post("/parse/preview-file", h.HandlePreviewFile)
			r.Post("/timestamp/preview", h.HandleTimestampPreview)
			r.Route("/logs", func(r chi.Router) {
				r.Get("/", h.HandleReadAll)
				r.Delete("/", h.HandleClear)
				r.Delete("/ids", h.HandleDeleteByIds)
			})
			r.Route("/workspaces", func(r chi.Router) {
				r.Get("/", h.HandleListWorkspaces)
				r.Post("/", h.HandleCreateWorkspace)
				r.Post("/{id}/duplicate", h.HandleDuplicateWorkspace)
				r.Get("/{id}", h.HandleGetWorkspace)
				r.Put("/{id}", h.HandleUpdateWorkspace)
				r.Delete("/{id}", h.HandleDeleteWorkspace)
			})
			r.Get("/info", h.HandleInfo)
			r.Route("/sources", func(r chi.Router) {
				r.Get("/", h.HandleListSources)
				r.Post("/rebuild", h.HandleRebuildSources)
				r.Get("/{name}", h.HandleGetSource)
				r.Patch("/{name}", h.HandleRenameSource)
				r.Post("/{name}/reimport", h.HandleReimportSource)
			})
			r.Route("/storage", func(r chi.Router) {
				r.Get("/", h.HandleGetStorage)
				r.Put("/", h.HandlePutStorage)
				r.Delete("/days/{date}", h.HandleDeleteStorageDay)
			})
			r.Route("/watches", func(r chi.Router) {
				r.Get("/", h.HandleListWatches)
				r.Post("/", h.HandleCreateWatch)
				r.Delete("/{id}", h.HandleDeleteWatch)
				r.Post("/{id}/pause", h.HandlePauseWatch)
				r.Post("/{id}/resume", h.HandleResumeWatch)
			})

			// Live-tail controls are short-lived JSON calls and can use the
			// normal API timeout/throttle budget.
			r.Post("/live/files", h.HandleLiveFileStart)
			r.Delete("/live/sources/{sourceID}", h.HandleLiveSourceStop)
			r.Post("/live/subscribers/{subscriberID}/pause", h.HandleLivePause)
			r.Post("/live/subscribers/{subscriberID}/resume", h.HandleLiveResume)

			// Add the new /grok endpoint with support for multiple methods
			r.Route("/grok", func(r chi.Router) {
				r.Post("/", h.HandleGrokPatterns)
				r.Get("/", h.HandleGrokPatterns)
				r.Put("/", h.HandleGrokPatterns)
				r.Delete("/", h.HandleGrokPatterns)
			})
		})
	})

	// Handle all non-API paths after API registration so the SPA catch-all never
	// shadows JSON or SSE routes.
	r.HandleFunc("/*", serveWithMimeType)

	srv.router = r
	return srv, nil
}

// Start initializes and starts the HTTP server. It blocks until SIGINT, SIGTERM,
// or SIGHUP is received (SIGHUP is what Terminal sends when its window/tab is
// closed), then performs a graceful shutdown with a 30-second drain timeout
// before closing all storage indices.
func (s *Server) Start() error {
	// Bind synchronously so port-in-use errors surface before any
	// "server started / open this URL" message is printed.
	ln, port, err := s.listen()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("http://%s", net.JoinHostPort(s.config.Host, strconv.Itoa(port)))
	s.mcpBaseURL.Store(url)

	httpServer := &http.Server{
		Handler: s.router,
	}

	// Accept connections before announcing the URL so the macOS WKWebView (and
	// any other client that loads immediately) cannot race an unbound Serve().
	serverErr := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()
	fmt.Printf("Server listening on %s\n", url)

	// Start session cleanup goroutine; cancel it on shutdown.
	cleanupCtx, cancelCleanup := context.WithCancel(context.Background())
	handlers.StartSessionCleanup(cleanupCtx, s.services)
	s.services.StartLive(cleanupCtx)
	s.services.StartWatches(cleanupCtx)
	s.services.StartIngestJobs(cleanupCtx)
	handlers.StartIngestJobCleanup(cleanupCtx)
	if s.services.Catalog != nil {
		s.services.Catalog.Start(cleanupCtx)
	}

	// Apply retention now and once a day; cancelled on shutdown.
	if s.services.Retention != nil {
		s.services.Retention.Start(cleanupCtx)
	}

	// Open the web UI once the listener is up.
	if s.config.OpenBrowser {
		go func() {
			time.Sleep(150 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Fprintf(os.Stderr, "could not open browser (%v) — open %s manually\n", err, url)
			}
		}()
	}

	// Listen for OS signals in the background.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)

	select {
	case err := <-serverErr:
		cancelCleanup()
		return err
	case <-quit:
		fmt.Println("\nShutting down server…")
	}

	cancelCleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		return fmt.Errorf("graceful shutdown failed: %w", err)
	}

	// Close all Bleve indices cleanly.
	if err := s.services.CloseStorage(); err != nil {
		return fmt.Errorf("storage close failed: %w", err)
	}

	fmt.Println("Server stopped.")
	return nil
}

// listen binds the server's TCP listener and returns it along with the port it
// actually bound. With AutoPort, a busy port is skipped and the next one is
// tried (scanning up to portScanRange ports); otherwise a busy port is fatal.
// The returned port may differ from the configured one, so callers use it (not
// config.Port) for the URL.
func (s *Server) listen() (net.Listener, int, error) {
	const portScanRange = 100

	basePort, err := parsePort(s.config.Port)
	if err != nil {
		return nil, 0, err
	}

	for port := basePort; port < basePort+portScanRange; port++ {
		addr := net.JoinHostPort(s.config.Host, strconv.Itoa(port))
		ln, lErr := net.Listen("tcp", addr)
		if lErr == nil {
			return ln, port, nil
		}
		if !s.config.AutoPort || !isAddrInUse(lErr) {
			return nil, 0, fmt.Errorf("listen %s: %w", addr, lErr)
		}
		// Port busy and AutoPort is on — try the next one.
	}
	return nil, 0, fmt.Errorf("no free port found in range %d-%d", basePort, basePort+portScanRange-1)
}

// parsePort turns a ":8080" or "8080" config value into an integer.
func parsePort(p string) (int, error) {
	n, err := strconv.Atoi(strings.TrimPrefix(p, ":"))
	if err != nil {
		return 0, fmt.Errorf("invalid port %q: %w", p, err)
	}
	return n, nil
}

// isAddrInUse reports whether err is the "address already in use" bind error.
func isAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE) ||
		strings.Contains(err.Error(), "address already in use")
}

// requireJSONBody rejects a POST/PUT/PATCH request that carries a body whose
// Content-Type is not application/json. Body-less requests of any method
// (a plain pause/resume POST, a DELETE with no payload) are untouched — this
// only closes the vector where a request actually has a payload the handler
// will try to json.Decode.
func requireJSONBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch:
			if hasRequestBody(r) && !isJSONContentType(r.Header.Get("Content-Type")) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnsupportedMediaType)
				json.NewEncoder(w).Encode(types.ErrorResponse{
					Status: "error",
					Error:  "Request body must be application/json",
					Code:   "UNSUPPORTED_MEDIA_TYPE",
				})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// hasRequestBody reports whether r appears to carry a body. Go sets
// ContentLength to -1 for a chunked/unknown-length body and to 0 when there
// is definitively no body; only 0 means "no body".
func hasRequestBody(r *http.Request) bool {
	return r.ContentLength != 0
}

// isJSONContentType reports whether contentType names application/json,
// ignoring parameters such as a charset (mime.ParseMediaType strips them).
func isJSONContentType(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == "application/json"
}

// openBrowser opens url in the user's default browser, per platform. It returns
// immediately (does not wait for the browser to close).
func openBrowser(url string) error {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd, args = "open", []string{url}
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default: // linux, bsd, …
		cmd, args = "xdg-open", []string{url}
	}
	return exec.Command(cmd, args...).Start()
}
