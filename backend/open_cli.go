package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"logsonic/pkg/server/handlers"
	"logsonic/pkg/types"
)

// `logsonic open` (spec now-12): hand one or more files to the running
// LogSonic — launching it if needed — import them by path through the same
// route the Dock drop uses, print progress from the server's SSE stream,
// then print the URL that shows them. --tail follows instead of importing.

// openLauncher is what "launch if needed" does to the outside world; the
// tests inject a fake and the real one spawns processes.
type openLauncher interface {
	// AppBundlePresent reports whether the macOS app bundle is installed.
	AppBundlePresent() bool
	// OpenWithApp launches the macOS app (bare: the CLI then imports
	// through the API like every other branch, so one import, one URL).
	OpenWithApp() (string, error)
	// SpawnServer starts a headless server bound to host:port; returns
	// what it ran.
	SpawnServer(host, port string, openBrowser bool) (string, error)
}

const (
	openLaunchWait   = 10 * time.Second
	openPollInterval = 250 * time.Millisecond
	macAppBundle     = "/Applications/Logsonic.app"
)

func runOpenCommand(args []string) int {
	return runOpen(args, os.Stdout, os.Stderr, realLauncher{})
}

func runOpen(args []string, stdout, stderr io.Writer, launcher openLauncher) int {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tail := fs.Bool("tail", false, "Follow the file (like tail -f) instead of importing it")
	patternName := fs.String("pattern", "", "Saved Grok pattern name (default: auto-detect from the first lines)")
	source := fs.String("source", "", "Source name for all the files together (default: one source per file, named after it)")
	baseURL := fs.String("url", "", "LogSonic base URL (default: LOGSONIC_URL or http://localhost:8080)")
	openUI := fs.Bool("open", false, "Open the result in the browser (the app is brought to the front regardless)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printOpenUsage(stdout)
			return 0
		}
		return 2
	}
	if fs.NArg() == 0 {
		fmt.Fprintln(stderr, "open: at least one file is required")
		printOpenUsage(stderr)
		return 2
	}

	paths, err := resolveOpenPaths(fs.Args())
	if err != nil {
		fmt.Fprintf(stderr, "open: %v\n", err)
		return 1
	}

	base := strings.TrimRight(*baseURL, "/")
	if base == "" {
		base = strings.TrimRight(os.Getenv("LOGSONIC_URL"), "/")
	}
	if base == "" {
		base = "http://localhost:8080"
	}

	if *tail {
		if len(paths) != 1 {
			fmt.Fprintln(stderr, "open --tail: exactly one file")
			return 2
		}
		if err := ensureServer(base, paths, false, launcher, stderr); err != nil {
			fmt.Fprintf(stderr, "open: %v\n", err)
			return 1
		}
		opts := types.IngestSessionOptions{Source: *source}
		if opts.Source == "" {
			opts.Source = filepath.Base(paths[0])
		}
		if *patternName != "" {
			opts.Name = *patternName
		} else {
			// Auto-detection is an import-time feature (the first batch);
			// a live source compiles its pattern at start, so tail keeps the
			// tail subcommand's default.
			opts.Name = handlers.DefaultPatternName
			opts.Pattern = handlers.DefaultPattern
		}
		return runTailFile(base, paths[0], opts)
	}

	if err := ensureServer(base, paths, *openUI, launcher, stderr); err != nil {
		fmt.Fprintf(stderr, "open: %v\n", err)
		return 1
	}

	// One session for all paths with --source, else one per file.
	type unit struct {
		source string
		paths  []string
	}
	var units []unit
	if *source != "" {
		units = []unit{{source: *source, paths: paths}}
	} else {
		for _, p := range paths {
			units = append(units, unit{source: filepath.Base(p), paths: []string{p}})
		}
	}

	events := newSSEClient(base)
	defer events.close()

	var lastSource string
	for _, u := range units {
		opts := types.IngestSessionOptions{Source: u.source, Meta: map[string]interface{}{"_src": u.source}}
		if *patternName != "" {
			opts.Name = *patternName
		} else {
			opts.Pattern = "auto"
		}
		sessionID, err := openStartSession(base, opts)
		if err != nil {
			fmt.Fprintf(stderr, "open: start session for %s: %v\n", u.source, err)
			return 1
		}
		// Files of one source are imported one after another so their
		// rows keep the file order (one seq counter per session).
		for _, p := range u.paths {
			jobID, err := openIngestFile(base, sessionID, p)
			if err != nil {
				fmt.Fprintf(stderr, "open: %s: %v\n", p, err)
				openEndSession(base, sessionID)
				return 1
			}
			job, err := events.waitForJob(base, jobID, func(j types.IngestJob) {
				fmt.Fprintf(stderr, "\r%s: %s lines, %s rows", filepath.Base(p), thousands(j.Lines), thousands(j.RowsStored))
			})
			fmt.Fprintln(stderr)
			if err != nil {
				fmt.Fprintf(stderr, "open: %s: %v\n", p, err)
				openEndSession(base, sessionID)
				return 1
			}
			if job.State != "done" {
				fmt.Fprintf(stderr, "open: %s: import %s: %s\n", p, job.State, job.Error)
				openEndSession(base, sessionID)
				return 1
			}
			fmt.Fprintf(stderr, "%s: imported %s rows as %s\n", filepath.Base(p), thousands(job.RowsStored), u.source)
		}
		openEndSession(base, sessionID)
		lastSource = u.source
	}

	uiURL := openResultURL(base, lastSource)
	fmt.Fprintln(stdout, uiURL)
	openFocus(base, uiURL)
	if *openUI {
		if err := openInBrowser(uiURL); err != nil {
			fmt.Fprintf(stderr, "open: could not open the browser (%v); open the URL above\n", err)
		}
	}
	return 0
}

func printOpenUsage(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  logsonic open [--tail] [--pattern NAME] [--source NAME] [--url http://localhost:8080] [--open] <file>...")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Imports the files into the running LogSonic (starting it if needed) and prints the URL that shows them.")
	fmt.Fprintln(w, "  --tail       follow the file as it grows instead of importing it (one file)")
	fmt.Fprintln(w, "  --pattern    saved Grok pattern name; default: detect from the first lines")
	fmt.Fprintln(w, "  --source     one source name for all files; default: one source per file")
	fmt.Fprintln(w, "  --open       open the result in the browser")
	fmt.Fprintln(w, "Exit codes: 0 ok, 1 failure, 2 usage.")
}

// resolveOpenPaths makes every argument absolute and checks it exists. The
// shell expands globs on Unix; on Windows a literal * is expanded here.
func resolveOpenPaths(args []string) ([]string, error) {
	var out []string
	for _, a := range args {
		candidates := []string{a}
		if runtime.GOOS == "windows" && strings.ContainsAny(a, "*?") {
			matches, err := filepath.Glob(a)
			if err != nil || len(matches) == 0 {
				return nil, fmt.Errorf("no files match %s", a)
			}
			candidates = matches
		}
		for _, c := range candidates {
			abs, err := filepath.Abs(c)
			if err != nil {
				return nil, fmt.Errorf("%s: %v", c, err)
			}
			st, err := os.Stat(abs)
			if err != nil {
				return nil, fmt.Errorf("%s: %v", abs, err)
			}
			if st.IsDir() {
				return nil, fmt.Errorf("%s is a directory (watch it from Settings → Watched folders)", abs)
			}
			out = append(out, abs)
		}
	}
	return out, nil
}

func pingServer(base string) bool {
	// Short: this runs inside the 10 s launch-retry loop, and a filtered
	// (not refused) port would otherwise eat the whole budget in a few tries.
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(base + "/api/v1/ping")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ensureServer pings; if nothing answers it launches — the app bundle when
// present (which imports the paths itself through the Dock-drop path), else
// a headless server — and waits up to openLaunchWait for the ping.
func ensureServer(base string, paths []string, openBrowser bool, launcher openLauncher, stderr io.Writer) error {
	if pingServer(base) {
		return nil
	}
	u, err := url.Parse(base)
	if err != nil {
		return fmt.Errorf("bad --url %q: %v", base, err)
	}
	var did string
	// The app bundle only helps when it will answer at base: it binds its
	// own (default, auto-shifting) port and ignores --url. Anything else
	// gets a headless server on exactly the requested port.
	if launcher.AppBundlePresent() && isDefaultServerURL(u) {
		did, err = launcher.OpenWithApp()
	} else {
		host, port := u.Hostname(), u.Port()
		if host == "" {
			host = "localhost"
		}
		if port == "" {
			port = "8080"
		}
		did, err = launcher.SpawnServer(host, port, openBrowser)
	}
	_ = paths
	if err != nil {
		return fmt.Errorf("LogSonic is not running at %s and could not be started: %v", base, err)
	}
	fmt.Fprintf(stderr, "open: LogSonic was not running at %s; started it: %s\n", base, did)
	deadline := time.Now().Add(openLaunchWait)
	for time.Now().Before(deadline) {
		if pingServer(base) {
			return nil
		}
		time.Sleep(openPollInterval)
	}
	return fmt.Errorf("started LogSonic (%s) but %s/api/v1/ping did not answer within %s", did, base, openLaunchWait)
}

// isDefaultServerURL reports whether u is where the macOS app would listen.
func isDefaultServerURL(u *url.URL) bool {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "8080"
	}
	return (host == "localhost" || host == "127.0.0.1") && port == "8080"
}

type realLauncher struct{}

func (realLauncher) AppBundlePresent() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	st, err := os.Stat(macAppBundle)
	return err == nil && st.IsDir()
}

// OpenWithApp launches the app without files: passing them would hand
// them to the import wizard (application(_:openFiles:)) *and* the CLI would
// import them through the API — two imports, one of them waiting on a
// click. The app comes up on the default port; the CLI imports as usual.
func (realLauncher) OpenWithApp() (string, error) {
	cmd := exec.Command("open", "-g", "-a", macAppBundle)
	return "open -g -a " + macAppBundle, cmd.Run()
}

// SpawnServer runs this binary as a detached headless server. STORAGE_PATH
// and the other env settings are inherited, so a test or a user with a
// custom index keeps it.
func (realLauncher) SpawnServer(host, port string, openBrowser bool) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	args := []string{"-host", host, "-port", port, "-auto-port=false"}
	if openBrowser {
		args = append(args, "-open")
	}
	cmd := exec.Command(self, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	cmd.SysProcAttr = detachedProcAttr()
	if err := cmd.Start(); err != nil {
		return "", err
	}
	_ = cmd.Process.Release()
	return self + " " + strings.Join(args, " "), nil
}

func openStartSession(base string, opts types.IngestSessionOptions) (string, error) {
	body, _ := json.Marshal(opts)
	resp, err := http.Post(base+"/api/v1/ingest/start", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out types.IngestResponse
	if err := decodeAPIResponse(resp, &out); err != nil {
		return "", err
	}
	if out.SessionID == "" {
		return "", errors.New("no session id in the response")
	}
	return out.SessionID, nil
}

func openIngestFile(base, sessionID, path string) (string, error) {
	body, _ := json.Marshal(types.IngestFileRequest{SessionID: sessionID, Path: path})
	resp, err := http.Post(base+"/api/v1/ingest/file", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out types.IngestFileResponse
	if err := decodeAPIResponse(resp, &out); err != nil {
		return "", err
	}
	return out.JobID, nil
}

func openEndSession(base, sessionID string) {
	body, _ := json.Marshal(map[string]string{"session_id": sessionID})
	resp, err := http.Post(base+"/api/v1/ingest/end", "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

// openResultURL is the UI link for one source: its rows, over exactly the
// time span the catalog recorded for it (padded a minute each side so a
// single-timestamp file gets a non-empty window).
func openResultURL(base, source string) string {
	q := url.Values{}
	q.Set("q", fmt.Sprintf("_src:%q", source))
	resp, err := http.Get(base + "/api/v1/sources/" + url.PathEscape(source))
	if err == nil {
		defer resp.Body.Close()
		var entry types.SourceEntry
		if decodeAPIResponse(resp, &entry) == nil && entry.FirstTS != nil && entry.LastTS != nil {
			q.Set("since", fmt.Sprint(entry.FirstTS.Add(-time.Minute).UnixMilli()))
			q.Set("to", fmt.Sprint(entry.LastTS.Add(time.Minute).UnixMilli()))
		}
	}
	if q.Get("since") == "" {
		q.Set("isRelative", "true")
		q.Set("relativeValue", "last-10-years")
	}
	return base + "/#/?" + q.Encode()
}

// openFocus asks the app window to come to the front at the route; a
// browser-mode server has no listener and the URL is printed anyway.
func openFocus(base, uiURL string) {
	route := ""
	if i := strings.Index(uiURL, "#"); i >= 0 {
		route = uiURL[i:]
	}
	body, _ := json.Marshal(types.UIFocusRequest{Route: route})
	resp, err := http.Post(base+"/api/v1/ui/focus", "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

func openInBrowser(u string) error {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd, args = "open", []string{u}
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", u}
	default:
		cmd, args = "xdg-open", []string{u}
	}
	return exec.Command(cmd, args...).Start()
}

func thousands(n int64) string {
	s := fmt.Sprint(n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// ----------------------------------------------------------------------------
// SSE progress: one connection to /live/events for the whole run; "hello"
// on (re)connect reconciles through GET /ingest/jobs, the same way the
// wizard's waitForIngestJob does, so a job that finished during a gap is
// never waited for forever.

type sseClient struct {
	cancel context.CancelFunc
	events chan sseEvent
}

type sseEvent struct {
	name string
	data string
}

func newSSEClient(base string) *sseClient {
	ctx, cancel := context.WithCancel(context.Background())
	c := &sseClient{cancel: cancel, events: make(chan sseEvent, 64)}
	go c.run(ctx, base)
	return c
}

func (c *sseClient) close() { c.cancel() }

func (c *sseClient) run(ctx context.Context, base string) {
	defer close(c.events)
	for ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1/live/events?source_id=__logsonic_open__", nil)
		if err != nil {
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				continue
			}
		}
		reader := bufio.NewReader(resp.Body)
		var name string
		var data strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case strings.HasPrefix(line, "event:"):
				name = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			case line == "":
				if name != "" {
					select {
					case c.events <- sseEvent{name: name, data: data.String()}:
					case <-ctx.Done():
					}
				}
				name, data = "", strings.Builder{}
			}
		}
		resp.Body.Close()
	}
}

// waitForJob returns the job's terminal snapshot, calling onProgress for
// every running snapshot. Besides SSE it polls GET /ingest/jobs once a
// second, which also covers a server that has no listener yet.
func (c *sseClient) waitForJob(base, jobID string, onProgress func(types.IngestJob)) (types.IngestJob, error) {
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	deadline := time.NewTimer(2 * time.Hour)
	defer deadline.Stop()
	for {
		select {
		case ev, ok := <-c.events:
			if !ok {
				return c.pollJob(base, jobID)
			}
			if ev.name != "ingest_progress" {
				continue
			}
			var job types.IngestJob
			if json.Unmarshal([]byte(ev.data), &job) != nil || job.JobID != jobID {
				continue
			}
			if job.State == "running" {
				onProgress(job)
				continue
			}
			return job, nil
		case <-poll.C:
			job, err := c.pollJob(base, jobID)
			if err != nil {
				return job, err
			}
			if job.State == "running" {
				onProgress(job)
				continue
			}
			return job, nil
		case <-deadline.C:
			return types.IngestJob{}, errors.New("gave up waiting for the import")
		}
	}
}

func (c *sseClient) pollJob(base, jobID string) (types.IngestJob, error) {
	resp, err := http.Get(base + "/api/v1/ingest/jobs")
	if err != nil {
		return types.IngestJob{}, err
	}
	defer resp.Body.Close()
	var out types.IngestJobsListResponse
	if err := decodeAPIResponse(resp, &out); err != nil {
		return types.IngestJob{}, err
	}
	for _, j := range out.Jobs {
		if j.JobID == jobID {
			return j, nil
		}
	}
	return types.IngestJob{}, fmt.Errorf("job %s is no longer listed by the server", jobID)
}
