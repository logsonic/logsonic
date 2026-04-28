package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"logsonic/pkg/server"
	"logsonic/pkg/stream"
	"logsonic/pkg/tokenizer"
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

	// Stream / ingestion flags
	streamFlag := flag.Bool("stream", false, "Read log lines from stdin and publish to the stream bus")
	pipeFlag := flag.Bool("pipe", false, "Alias for --stream")
	syslogPortFlag := flag.Int("syslog-port", 514, "UDP/TCP port for syslog receiver (0 = disabled)")
	syslogProtoFlag := flag.String("syslog-proto", "both", "Syslog protocol: udp|tcp|both")
	devEventsFlag := flag.Bool("dev-events", false, "Publish synthetic log events every 2s (for stream UI testing)")

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
		if runtime.GOOS == "windows" {
			storagePath = os.Getenv("APPDATA") + "\\logsonic"
		} else {
			storagePath = workDir + "/.logsonic"
		}
	}

	pipeMode := *streamFlag || *pipeFlag
	syslogEnabled := *syslogPortFlag > 0

	// Bus is always created so the /stream/ws endpoint is always available.
	bus := stream.NewBus()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start ingestion sources before the HTTP server.
	{
		tok, err := tokenizer.NewTokenizer()
		if err != nil {
			log.Fatalf("failed to initialize tokenizer for stream: %v", err)
		}

		if pipeMode {
			log.Println("Stream mode: reading from stdin")
			go stream.PipeReader(ctx, os.Stdin, bus, tok)
		}

		if syslogEnabled {
			recv := &stream.SyslogReceiver{
				Port:  *syslogPortFlag,
				Proto: *syslogProtoFlag,
				Bus:   bus,
			}
			if err := recv.Start(ctx); err != nil {
				log.Fatalf("failed to start syslog receiver: %v", err)
			}
		}
	}

	log.Println("Starting server on", host+port, "with storage path", storagePath)
	cfg := server.Config{
		Host:        host,
		Port:        port,
		StoragePath: storagePath,
		WorkDir:     workDir,
		Timeout:     60 * time.Second,
		StreamBus:   bus,
		DevEvents:   *devEventsFlag,
	}

	fmt.Println("Please open the following URL in your browser: http://" + host + port)
	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	if err := srv.Start(); err != nil {
		if strings.Contains(err.Error(), "bind:") || strings.Contains(err.Error(), "listen:") {
			log.Printf("Failed to bind to address %s: %v", host+port, err)
			log.Println("Please check if the port is already in use or if you have permission to bind to this address")
			os.Exit(1)
		}
		log.Fatalf("Server failed: %v", err)
	}
}

func printUsage() {
	fmt.Println("LogSonic - Desktop Log ingestion and analysis server. Simple, minimal and fast.")
	fmt.Println("\nUsage:")
	fmt.Println("  logsonic [options]")
	fmt.Println("\nOptions:")
	fmt.Println("  -host string       Host address to bind to (default: localhost or HOST env var)")
	fmt.Println("  -port string       Port to listen on (default: 8080 or PORT env var)")
	fmt.Println("  -storage string    Path to storage directory (default: STORAGE_PATH env var)")
	fmt.Println("  -stream            Read log lines from stdin and publish to stream bus")
	fmt.Println("  -pipe              Alias for --stream")
	fmt.Println("  -syslog-port int   UDP/TCP syslog listener port (default 514, 0=disabled)")
	fmt.Println("  -syslog-proto str  Syslog protocol: udp|tcp|both (default both)")
	fmt.Println("  -dev-events        Publish synthetic log events every 2s (stream UI testing)")
	fmt.Println("  -help              Show this help message")
	fmt.Println("\nEnvironment Variables:")
	fmt.Println("  HOST           Host address to bind to")
	fmt.Println("  PORT           Port to listen on")
	fmt.Println("  STORAGE_PATH   Path to storage directory")
	fmt.Println("\nExamples:")
	fmt.Println("  logsonic")
	fmt.Println("  logsonic --stream                        # pipe stdin → stream bus → WebSocket")
	fmt.Println("  echo 'hello' | logsonic --stream")
	fmt.Println("  logsonic --syslog-port 514               # start syslog receiver")
	fmt.Println("  logsonic --syslog-port 5140 --syslog-proto udp")
	fmt.Println("  logsonic -host localhost -port 8080 -storage /var/logs/storage")
	fmt.Println("  HOST=localhost PORT=8080 STORAGE_PATH=/var/logs/storage logsonic")
}
