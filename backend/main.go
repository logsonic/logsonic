package main

import (
	"flag"
	"fmt"
	"log"
	"logsonic/pkg/server"
	"os"
	"runtime"
	"strings"
	"time"
)

func main() {
	// Define command line flags
	hostFlag := flag.String("host", "", "Host address to bind to (default: localhost or HOST env var)")
	portFlag := flag.String("port", "", "Port to listen on (default: 8080 or PORT env var)")
	storageFlag := flag.String("storage", "", "Path to storage directory (default: STORAGE_PATH env var)")
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

	// Get storage path from command line flag or environment variable
	storagePath := *storageFlag
	if storagePath == "" {
		storagePath = os.Getenv("STORAGE_PATH")
	}

	// Get working directory for defaults
	workDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("failed to get working directory: %v", err)
	}

	if storagePath == "" {
		//For windows folder, use %appdata%
		if runtime.GOOS == "windows" {
			storagePath = os.Getenv("APPDATA") + "\\logsonic"
		} else {

			storagePath = workDir + "/.logsonic"
		}
	}

	log.Println("Starting server on", host+port, "with storage path", storagePath)
	cfg := server.Config{
		Host:        host,
		Port:        port,
		StoragePath: storagePath,
		WorkDir:     workDir,
		Timeout:     60 * time.Second,
	}

	fmt.Println("Please open the following URL in your browser: http://" + host + port)
	// Try to create the server
	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	// Try to start the server, handle binding errors gracefully
	if err := srv.Start(); err != nil {
		// Check if it's an address binding error
		if strings.Contains(err.Error(), "bind:") || strings.Contains(err.Error(), "listen:") {
			log.Printf("Failed to bind to address %s: %v", host+port, err)
			log.Println("Please check if the port is already in use or if you have permission to bind to this address")
			os.Exit(1)
		}
		// Other server errors
		log.Fatalf("Server failed: %v", err)
	}
}

func printUsage() {
	fmt.Println("LogSonic - Desktop Log ingestion and analysis server. Simple, minimal and fast.")
	fmt.Println("\nUsage:")
	fmt.Println("  logsonic [options]")
	fmt.Println("\nOptions:")
	fmt.Println("  -host string    Host address to bind to (default: localhost or HOST env var)")
	fmt.Println("  -port string    Port to listen on (default: 8080 or PORT env var)")
	fmt.Println("  -storage string Path to storage directory (default: STORAGE_PATH env var)")
	fmt.Println("  -help           Show this help message")
	fmt.Println("\nEnvironment Variables:")
	fmt.Println("  HOST           Host address to bind to")
	fmt.Println("  PORT           Port to listen on")
	fmt.Println("  STORAGE_PATH   Path to storage directory")
	fmt.Println("\nExamples:")
	fmt.Println("  logsonic")
	fmt.Println("  logsonic -host localhost -port 8080 -storage /var/logs/storage")
	fmt.Println("  HOST=localhost PORT=8080 STORAGE_PATH=/var/logs/storage logsonic")
}
