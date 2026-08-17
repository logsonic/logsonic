package server

import (
	"context"
	"errors"
	"fmt"
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

	"logsonic/pkg/static"
	"logsonic/pkg/storage"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
	httpSwagger "github.com/swaggo/http-swagger"
)

// @title LogSonic API
// @version 1.0
// @description API for ingesting, storing, and querying log data with Grok pattern support
// @host localhost:8080
// @BasePath /api/v1

type Config struct {
	Port        string
	StoragePath string
	WorkDir     string // Directory where log files are stored
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
	r.Use(middleware.RealIP)
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

	// Initialize handler
	h := handlers.NewHandler(store, cfg.StoragePath)
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

	// Set up API routes
	r.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(cfg.Timeout))
		r.Use(middleware.ThrottleBacklog(10, 50, 5*time.Second))
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

			// Parse endpoints
			r.Post("/parse", h.HandleParse)
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
	fmt.Printf("Server listening on %s\n", url)

	httpServer := &http.Server{
		Handler: s.router,
	}

	// Start session cleanup goroutine; cancel it on shutdown.
	cleanupCtx, cancelCleanup := context.WithCancel(context.Background())
	handlers.StartSessionCleanup(cleanupCtx, s.services)
	s.services.StartLive(cleanupCtx)

	// Apply retention now and once a day; cancelled on shutdown.
	s.startRetention(cleanupCtx)

	// Open the web UI once the listener is up (the serve goroutine starts
	// below, so a short delay avoids racing the first request).
	if s.config.OpenBrowser {
		go func() {
			time.Sleep(500 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Fprintf(os.Stderr, "could not open browser (%v) — open %s manually\n", err, url)
			}
		}()
	}

	// Listen for OS signals in the background.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)

	serverErr := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

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

// startRetention deletes indices older than RetentionDays now, then once a day
// until ctx is cancelled. A non-positive RetentionDays disables it entirely.
func (s *Server) startRetention(ctx context.Context) {
	if s.config.RetentionDays <= 0 {
		return
	}
	maxAge := time.Duration(s.config.RetentionDays) * 24 * time.Hour

	prune := func() {
		removed, err := s.store.PruneOlderThan(maxAge)
		if err != nil {
			fmt.Fprintf(os.Stderr, "retention: prune failed: %v\n", err)
			return
		}
		if removed > 0 {
			fmt.Printf("retention: removed %d index(es) older than %d day(s)\n", removed, s.config.RetentionDays)
		}
	}

	prune() // sweep once at startup

	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				prune()
			}
		}
	}()
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
