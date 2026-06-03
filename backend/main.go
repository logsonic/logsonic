package main

import (
	"flag"
	"fmt"
	"log"
	"logsonic/pkg/server"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func main() {
	// Define command line flags
	hostFlag := flag.String("host", "", "Host address to bind to (default: localhost or HOST env var)")
	portFlag := flag.String("port", "", "Port to listen on (default: 8080 or PORT env var)")
	storageFlag := flag.String("storage", "", "Path to storage directory (default: per-user app data dir)")
	openFlag := flag.Bool("open", false, "Open the web UI in your browser once the server starts")
	autoPortFlag := flag.Bool("auto-port", false, "If the port is busy, bind the next free port instead of failing")
	retentionFlag := flag.Int("retention-days", 0, "Delete indexed logs older than N days (0 = keep everything)")
	helpFlag := flag.Bool("help", false, "Show usage information")

	// Parse command line arguments
	flag.Parse()

	// Show usage if help flag is provided
	if *helpFlag {
		printUsage()
		return
	}

	// Get host from command line flag, environment variable, or use default
	host := *hostFlag
	if host == "" {
		host = os.Getenv("HOST")
		if host == "" {
			host = "localhost"
		}
	}

	// Get port from command line flag, environment variable, or use default
	port := *portFlag
	if port == "" {
		port = os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
	}

	// Ensure port starts with ":"
	if !strings.HasPrefix(port, ":") {
		port = ":" + port
	}

	// Resolve storage path: flag > STORAGE_PATH env > per-user app data dir.
	storagePath := *storageFlag
	if storagePath == "" {
		storagePath = os.Getenv("STORAGE_PATH")
	}
	if storagePath == "" {
		p, derr := defaultStoragePath()
		if derr != nil {
			log.Fatalf("failed to resolve default storage path: %v", derr)
		}
		storagePath = p
	}

	// Get working directory for defaults
	workDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("failed to get working directory: %v", err)
	}

	// The macOS .app launches with no flags and cwd "/". Its Info.plist sets
	// LSEnvironment LOGSONIC_APP=1, which LaunchServices injects ONLY on
	// double-click — never when the bundled binary is run from a terminal (e.g.
	// via the Homebrew-symlinked `logsonic`). So app-launch gets the desktop
	// defaults (open the browser, auto-select a port) while the CLI stays
	// classic unless its own flags/env opt in.
	asApp := envTrue("LOGSONIC_APP")
	openBrowser := *openFlag || envTrue("LOGSONIC_OPEN_BROWSER") || asApp
	autoPort := *autoPortFlag || envTrue("LOGSONIC_AUTO_PORT") || asApp

	// A macOS .app double-click runs this binary faceless: no controlling
	// terminal and no Cocoa event loop, so the Dock reports it "not responding"
	// (it never answers the Quit Apple Event — the only way out is Force Quit,
	// which SIGKILLs us with no graceful shutdown) and there's no visible output.
	// On macOS, relaunchForApp re-launches the server inside a Terminal window
	// (visible logs; Ctrl-C or closing the window delivers SIGINT/SIGHUP for a
	// clean shutdown) and reports true so this faceless launcher can exit. It's a
	// no-op on other platforms. See app_relaunch_darwin.go.
	if asApp && relaunchForApp() {
		return
	}

	retentionDays := *retentionFlag
	if retentionDays == 0 {
		if v := os.Getenv("RETENTION_DAYS"); v != "" {
			if n, parseErr := strconv.Atoi(v); parseErr == nil {
				retentionDays = n
			}
		}
	}

	log.Println("Starting server on", host+port, "with storage path", storagePath)
	cfg := server.Config{
		Host:          host,
		Port:          port,
		StoragePath:   storagePath,
		WorkDir:       workDir,
		Timeout:       60 * time.Second,
		OpenBrowser:   openBrowser,
		AutoPort:      autoPort,
		RetentionDays: retentionDays,
	}

	// Try to create the server
	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	// Try to start the server, handle binding errors gracefully.
	// Start() binds synchronously and returns the bind error before
	// any "server started" message, so port-in-use is loud and fatal.
	if err := srv.Start(); err != nil {
		if strings.Contains(err.Error(), "bind:") ||
			strings.Contains(err.Error(), "listen:") ||
			strings.Contains(err.Error(), "address already in use") {
			fmt.Fprintf(os.Stderr, "\nERROR: Cannot bind to %s — %v\n", host+port, err)
			fmt.Fprintln(os.Stderr, "Port is already in use. Stop the other process or pick a different port with -port <N> (or PORT env var).")
			os.Exit(1)
		}
		log.Fatalf("Server failed: %v", err)
	}
}

// defaultStoragePath returns the per-user data directory for logsonic's indices,
// following each platform's convention so the location is stable regardless of
// the working directory (important for the .app, which launches with cwd "/"):
//
//	macOS:   ~/Library/Application Support/Logsonic
//	Windows: %APPDATA%\Logsonic
//	Linux:   $XDG_DATA_HOME/logsonic  (or ~/.local/share/logsonic)
//
// The directory itself is created later by storage.NewStorage.
func defaultStoragePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Logsonic"), nil
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Logsonic"), nil
	default: // linux and other unixes
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "logsonic"), nil
	}
}

// envTrue reports whether an env var is set to a truthy value (1/true/yes/on).
func envTrue(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func printUsage() {
	fmt.Println("LogSonic - Desktop Log ingestion and analysis server. Simple, minimal and fast.")
	fmt.Println("\nUsage:")
	fmt.Println("  logsonic [options]")
	fmt.Println("\nOptions:")
	fmt.Println("  -host string      Host address to bind to (default: localhost or HOST env var)")
	fmt.Println("  -port string      Port to listen on (default: 8080 or PORT env var)")
	fmt.Println("  -storage string   Path to storage directory (default: per-user app data dir)")
	fmt.Println("  -open             Open the web UI in your browser once the server starts")
	fmt.Println("  -auto-port        If the port is busy, bind the next free port instead of failing")
	fmt.Println("  -retention-days N Delete indexed logs older than N days (0 = keep everything)")
	fmt.Println("  -help             Show this help message")
	fmt.Println("\nEnvironment Variables:")
	fmt.Println("  HOST                  Host address to bind to")
	fmt.Println("  PORT                  Port to listen on")
	fmt.Println("  STORAGE_PATH          Path to storage directory")
	fmt.Println("  LOGSONIC_OPEN_BROWSER Open the web UI on start (1/true/yes/on)")
	fmt.Println("  LOGSONIC_AUTO_PORT    Auto-select a free port if busy (1/true/yes/on)")
	fmt.Println("  RETENTION_DAYS        Delete indexed logs older than N days")
	fmt.Println("\nStorage directory (default):")
	fmt.Println("  macOS    ~/Library/Application Support/Logsonic")
	fmt.Println("  Linux    $XDG_DATA_HOME/logsonic (or ~/.local/share/logsonic)")
	fmt.Println("  Windows  %APPDATA%\\Logsonic")
	fmt.Println("\nExamples:")
	fmt.Println("  logsonic")
	fmt.Println("  logsonic -open -auto-port")
	fmt.Println("  logsonic -host localhost -port 8080 -storage /var/logs/storage -retention-days 30")
}
