package server

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"logsonic/docs"
	"logsonic/pkg/server/handlers"

	"logsonic/pkg/static"
	"logsonic/pkg/storage"
	"logsonic/pkg/tokenizer"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
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
}

type Server struct {
	router   chi.Router
	services *handlers.Services
	config   Config
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

	// Initialize tokenizer
	tokenizer, err := tokenizer.NewTokenizer()
	if err != nil {
		return nil, fmt.Errorf("failed to initialize tokenizer: %w", err)
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
	r.Use(middleware.Timeout(cfg.Timeout))

	// Add rate limiting middleware
	r.Use(middleware.ThrottleBacklog(10, 50, 5*time.Second))

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
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300, // Maximum value not ignored by any of major browsers
	}))

	// Initialize handler
	h := handlers.NewHandler(store, tokenizer, cfg.StoragePath)

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

	// Initialize Grok patterns
	h.InitializeGrokPatterns()

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

	// Handle all paths
	r.HandleFunc("/*", serveWithMimeType)

	// Set up API routes
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
		r.Route("/logs", func(r chi.Router) {
			r.Get("/", h.HandleReadAll)
			r.Delete("/", h.HandleClear)
		})
		r.Get("/info", h.HandleInfo)

		// Add the new /grok endpoint with support for multiple methods
		r.Route("/grok", func(r chi.Router) {
			r.Post("/", h.HandleGrokPatterns)
			r.Get("/", h.HandleGrokPatterns)
			r.Put("/", h.HandleGrokPatterns)
			r.Delete("/", h.HandleGrokPatterns)
		})

		// Add CloudWatch endpoints
		r.Route("/cloudwatch", func(r chi.Router) {
			r.Post("/log-groups", h.HandleListCloudWatchLogGroups)
			r.Post("/log-streams", h.HandleListCloudWatchLogStreams)
			r.Post("/log-events", h.HandleGetCloudWatchLogEvents)
		})

	})

	return &Server{
		router:   r,
		services: h,
		config:   cfg,
	}, nil
}

// Start initializes and starts the HTTP server
func (s *Server) Start() error {
	fmt.Printf("Server starting on %s\n", s.config.Host+s.config.Port)
	return http.ListenAndServe(s.config.Host+s.config.Port, s.router)
}

// Move all the request/response types and handler methods here...
// [Copy all the types and handler methods from main.go]
