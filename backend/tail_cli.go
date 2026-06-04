package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"logsonic/pkg/server/handlers"
	"logsonic/pkg/types"
)

func runTailCommand(args []string) int {
	fs := flag.NewFlagSet("tail", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	followPath := fs.String("f", "", "File to follow server-side")
	baseURL := fs.String("url", "", "LogSonic base URL (default: LOGSONIC_URL or http://localhost:8080)")
	source := fs.String("source", "", "Source name stamped onto live rows")
	patternName := fs.String("pattern", "", "Saved Grok pattern name")
	grok := fs.String("grok", "", "Inline Grok pattern")
	smart := fs.Bool("smart", false, "Enable smart decoding for common values")

	stdinMode := false
	filteredArgs := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "-" {
			stdinMode = true
			continue
		}
		filteredArgs = append(filteredArgs, arg)
	}

	if err := fs.Parse(filteredArgs); err != nil {
		return 2
	}

	url := strings.TrimRight(*baseURL, "/")
	if url == "" {
		url = strings.TrimRight(os.Getenv("LOGSONIC_URL"), "/")
	}
	if url == "" {
		url = "http://localhost:8080"
	}

	opts := types.IngestSessionOptions{
		Source:       *source,
		SmartDecoder: *smart,
	}
	switch {
	case *grok != "":
		opts.Name = "CLI_CUSTOM_PATTERN"
		opts.Pattern = *grok
	case *patternName != "":
		opts.Name = *patternName
	default:
		opts.Name = handlers.DefaultPatternName
		opts.Pattern = handlers.DefaultPattern
	}

	if *followPath != "" {
		if opts.Source == "" {
			opts.Source = filepath.Base(*followPath)
		}
		return runTailFile(url, *followPath, opts)
	}

	if stdinMode {
		if opts.Source == "" {
			opts.Source = "stdin"
		}
		return runTailStdin(url, opts)
	}

	printTailUsage()
	return 2
}

func runTailFile(baseURL, path string, opts types.IngestSessionOptions) int {
	body, _ := json.Marshal(types.LiveFileRequest{
		Path:    path,
		Options: opts,
	})
	resp, err := http.Post(baseURL+"/api/v1/live/files", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: start failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()

	var out types.LiveSourceResponse
	if err := decodeAPIResponse(resp, &out); err != nil {
		fmt.Fprintf(os.Stderr, "tail: start failed: %v\n", err)
		return 1
	}
	if out.SourceID == "" {
		fmt.Fprintln(os.Stderr, "tail: server did not return a source_id")
		return 1
	}

	fmt.Fprintf(os.Stderr, "live source started: %s\n", out.SourceID)
	fmt.Fprintln(os.Stderr, "press Ctrl+C to stop tailing")

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	<-sigs
	signal.Stop(sigs)

	req, err := http.NewRequest(http.MethodDelete, baseURL+"/api/v1/live/sources/"+out.SourceID, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: stop failed: %v\n", err)
		return 1
	}
	stopResp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: stop failed: %v\n", err)
		return 1
	}
	defer stopResp.Body.Close()
	var stopOut types.LiveSourceResponse
	if err := decodeAPIResponse(stopResp, &stopOut); err != nil {
		fmt.Fprintf(os.Stderr, "tail: stop failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "live source stopped: %s\n", out.SourceID)
	return 0
}

func runTailStdin(baseURL string, opts types.IngestSessionOptions) int {
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/live/stdin", os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: request failed: %v\n", err)
		return 1
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	encoded, err := encodeLiveOptions(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: options failed: %v\n", err)
		return 1
	}
	req.Header.Set("X-Logsonic-Live-Options", encoded)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tail: stream failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()

	var out types.LiveSourceResponse
	if err := decodeAPIResponse(resp, &out); err != nil {
		fmt.Fprintf(os.Stderr, "tail: stream failed: %v\n", err)
		return 1
	}
	return 0
}

func encodeLiveOptions(opts types.IngestSessionOptions) (string, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func decodeAPIResponse(resp *http.Response, target interface{}) error {
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return err
	}
	return nil
}

func printTailUsage() {
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  logsonic tail -f /path/to/file [--url http://localhost:8080] [--source NAME] [--pattern NAME | --grok '...']")
	fmt.Fprintln(os.Stderr, "  cmd | logsonic tail - [--url http://localhost:8080] [--source NAME] [--pattern NAME | --grok '...']")
}
