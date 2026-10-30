package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"logsonic/pkg/agentmcp"
	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

func toolString(in map[string]any, key string) string {
	v, _ := in[key].(string)
	return strings.TrimSpace(v)
}

func (h *Services) runAgentTool(ctx context.Context, name string, in map[string]any) (any, error) {
	switch name {
	case "ingest_local":
		return h.agentIngestLocal(ctx, toolString(in, "path"))
	case "ingest_remote":
		return h.agentIngestRemote(ctx, toolString(in, "url"))
	case "ingest_cloudwatch":
		return h.agentIngestCloudWatch(ctx, in)
	case "list_sources":
		if h.Catalog == nil {
			return nil, errors.New("source catalog unavailable")
		}
		list := h.Catalog.List()
		if len(list) > 100 {
			list = list[:100]
		}
		out := make([]map[string]any, 0, len(list))
		for _, s := range list {
			out = append(out, map[string]any{"name": s.Name, "rows": s.Rows, "first_ts": s.FirstTS, "last_ts": s.LastTS})
		}
		return map[string]any{"sources": out}, nil
	case "query_logs":
		return h.agentQuery(ctx, in, false)
	case "analyze_logs":
		return h.agentQuery(ctx, in, true)
	case "facet_logs":
		return h.agentFacets(ctx, in)
	case "log_histogram":
		return h.agentHistogram(ctx, in)
	case "log_context":
		return h.agentContext(ctx, in)
	case "compare_windows":
		return h.agentCompareWindows(ctx, in)
	case "log_patterns":
		return h.agentPatterns(ctx, in)
	case "save_view":
		return h.agentSaveView(ctx, in)
	default:
		if h.AgentUITools != nil && strings.HasPrefix(name, "ui_") {
			return h.AgentUITools.Call(ctx, name, in)
		}
		if h.AgentMCP != nil && strings.HasPrefix(name, agentmcp.ToolPrefix) {
			return h.AgentMCP.Call(ctx, name, in)
		}
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

// Bounds for importing a whole folder. A folder with more files asks the
// model to name the files instead.
const (
	agentMaxDirEntries = 4096
	agentMaxDirFiles   = 16
)

// Folders and files that hold credentials rather than logs. Other dot
// folders stay importable: ~/.ollama/logs, ~/.pm2/logs and ~/.npm/_logs are
// common log locations.
var (
	agentSecretDirs = map[string]bool{
		".ssh": true, ".gnupg": true, ".aws": true, ".azure": true, ".kube": true,
		".password-store": true, "Keychains": true,
	}
	agentSecretConfigDirs = map[string]bool{"gcloud": true, "gh": true}
	agentSecretFiles      = map[string]bool{
		".netrc": true, ".git-credentials": true, ".npmrc": true, ".pypirc": true,
		".pgpass": true, ".my.cnf": true, ".bash_history": true, ".zsh_history": true,
		".python_history": true, ".psql_history": true, ".mysql_history": true,
	}
	agentSystemSecretFiles = map[string]bool{
		"/etc/passwd": true, "/etc/shadow": true, "/etc/master.passwd": true, "/etc/sudoers": true,
		"/private/etc/passwd": true, "/private/etc/shadow": true, "/private/etc/master.passwd": true, "/private/etc/sudoers": true,
	}
)

// agentSecretPath reports whether path names a credential location.
func agentSecretPath(path string) bool {
	if agentSystemSecretFiles[path] {
		return true
	}
	parts := strings.Split(path, string(filepath.Separator))
	for i, part := range parts {
		if agentSecretDirs[part] {
			return true
		}
		if i+1 < len(parts) {
			next := parts[i+1]
			if part == ".config" && agentSecretConfigDirs[next] || part == ".docker" && next == "config.json" {
				return true
			}
		}
	}
	base := filepath.Base(path)
	return agentSecretFiles[base] || base == ".env" || strings.HasPrefix(base, ".env.")
}

// agentExpandPath turns the path the model sends into an absolute one.
// "~", "~/…" and "$HOME/…" expand to the user's home folder, and a relative
// path is taken as relative to it: "Downloads/app.log" means the user's
// Downloads folder, not the server's working directory. Surrounding quotes
// and a file:// prefix are dropped.
func agentExpandPath(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if len(path) >= 2 && (path[0] == '"' || path[0] == '\'') && path[len(path)-1] == path[0] {
		path = path[1 : len(path)-1]
	}
	if rest, ok := strings.CutPrefix(path, "file://"); ok {
		if unescaped, err := url.PathUnescape(rest); err == nil {
			rest = unescaped
		}
		path = rest
	}
	if path == "" {
		return "", errors.New("path required")
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("absolute path required")
	}
	switch {
	case path == "~" || path == "$HOME":
		return home, nil
	case strings.HasPrefix(path, "~/"):
		path = path[2:]
	case strings.HasPrefix(path, "$HOME/"):
		path = path[len("$HOME/"):]
	case strings.HasPrefix(path, "~"):
		// ~otheruser/… names another account's home.
		return "", errors.New("only your own home folder (~/…) or an absolute path is supported")
	}
	return filepath.Join(home, path), nil
}

// agentPathError explains a failure to read a path. On macOS, Desktop,
// Documents and Downloads are protected: the first read asks the user, and
// a refusal stays until it is changed in System Settings.
func agentPathError(path string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("no such file or folder: %s", path)
	}
	if errors.Is(err, fs.ErrPermission) {
		if runtime.GOOS == "darwin" {
			return fmt.Errorf("macOS did not allow LogSonic to read %s. Allow it in System Settings > Privacy & Security > Files and Folders (or Full Disk Access), then try again", path)
		}
		return fmt.Errorf("permission denied reading %s", path)
	}
	return err
}

// validateAgentLocalPath expands ~ and relative paths (see agentExpandPath),
// resolves symlinks and refuses credential locations (checked on both the
// given and the resolved path) and, when LOGSONIC_AGENT_INGEST_ROOT is set,
// anything outside that folder. Everything else, the whole home folder
// included, is importable.
func validateAgentLocalPath(raw string) (string, error) {
	path, err := agentExpandPath(raw)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", agentPathError(path, err)
	}
	for _, candidate := range []string{filepath.Clean(path), resolved} {
		if agentSecretPath(candidate) {
			return "", errors.New("refusing to import a credential file or folder")
		}
	}
	if root := strings.TrimSpace(os.Getenv("LOGSONIC_AGENT_INGEST_ROOT")); root != "" {
		cleanRoot := filepath.Clean(root)
		if evalRoot, err := filepath.EvalSymlinks(cleanRoot); err == nil {
			cleanRoot = evalRoot
		}
		rel, relErr := filepath.Rel(cleanRoot, resolved)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("path must be inside LOGSONIC_AGENT_INGEST_ROOT (%s)", cleanRoot)
		}
	}
	return resolved, nil
}

func (h *Services) agentIngestLocal(ctx context.Context, path string) (any, error) {
	resolved, err := validateAgentLocalPath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, agentPathError(resolved, err)
	}
	paths := []string{resolved}
	var skipped []map[string]string
	if info.IsDir() {
		dir, err := os.Open(resolved)
		if err != nil {
			return nil, agentPathError(resolved, err)
		}
		entries, readErr := dir.ReadDir(agentMaxDirEntries + 1)
		dir.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, agentPathError(resolved, readErr)
		}
		if len(entries) > agentMaxDirEntries {
			return nil, fmt.Errorf("directory has more than %d entries; name the log files to import instead", agentMaxDirEntries)
		}
		paths = nil
		// Hidden files (.DS_Store, editor swap files) are skipped quietly;
		// entries refused by validation or that are not regular files (a
		// symlink to a folder, a socket) are skipped and reported.
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			child, err := validateAgentLocalPath(filepath.Join(resolved, entry.Name()))
			if err == nil {
				if fi, statErr := os.Stat(child); statErr != nil {
					err = statErr
				} else if !fi.Mode().IsRegular() {
					err = errors.New("not a regular file")
				}
			}
			if err != nil {
				skipped = append(skipped, map[string]string{"name": entry.Name(), "reason": err.Error()})
				continue
			}
			paths = append(paths, child)
		}
		if len(paths) == 0 {
			return nil, errors.New("directory has no importable files")
		}
		sort.Strings(paths)
		if len(paths) > agentMaxDirFiles {
			names := make([]string, 0, 10)
			for _, p := range paths[:min(10, len(paths))] {
				names = append(names, filepath.Base(p))
			}
			return nil, fmt.Errorf("directory has %d files, more than %d; import specific files instead (for example %s)", len(paths), agentMaxDirFiles, strings.Join(names, ", "))
		}
	}
	results := make([]any, 0, len(paths))
	for _, file := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := h.agentImportPath(ctx, file, filepath.Base(file), nil)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	out := map[string]any{"imports": results}
	if len(skipped) > 0 {
		out["skipped"] = skipped
	}
	return out, nil
}

func (h *Services) agentImportPath(ctx context.Context, file, source string, origin *types.SourceOrigin) (any, error) {
	fi, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 64*1024*1024 {
		return nil, fmt.Errorf("file must be regular and at most 64 MiB: %s", file)
	}
	canonical, members, compression, openErr := openFileForImport(ctx, file, false)
	if openErr != nil {
		return nil, openErr
	}
	// Check the opened path again, so a symlink swapped in after validation
	// cannot redirect a local import to a refused file.
	if origin == nil {
		if _, err := validateAgentLocalPath(canonical); err != nil {
			return nil, err
		}
	}
	id, startErr := newIngestSession(types.IngestSessionOptions{Name: "AUTO", Pattern: "auto", Source: source, Meta: map[string]interface{}{"_src": source}})
	if startErr != nil {
		return nil, startErr
	}
	job, jobCtx := h.newIngestFileJob(id, canonical, members, compression, true, "file")
	if origin != nil {
		sessionMapMutex.Lock()
		session := sessionMap[id]
		session.Origin = *origin
		sessionMap[id] = session
		sessionMapMutex.Unlock()
	}
	go h.runIngestFileJob(jobCtx, job)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for job.currentState() == ingestJobStateRunning {
		select {
		case <-ctx.Done():
			job.cancel()
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
	snapshot := job.snapshot()
	if snapshot.State != ingestJobStateDone {
		return nil, fmt.Errorf("import %s: %s", file, snapshot.Error)
	}
	result := map[string]any{"source": source, "rows_stored": snapshot.RowsStored, "rows_failed": snapshot.RowsFailed}
	if origin == nil {
		result["path"] = canonical
	} else {
		result["origin"] = *origin
	}
	return result, nil
}

func (h *Services) agentIngestRemote(ctx context.Context, raw string) (any, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return nil, errors.New("public HTTPS URL required")
	}
	// Validate at connection time as well as on every redirect, so DNS rebinding
	// cannot make the HTTP client fetch a loopback or private network address.
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if !publicDownloadIP(ip.IP) {
				return nil, errors.New("remote host resolves to non-public address")
			}
		}
		if len(ips) == 0 {
			return nil, errors.New("remote host has no address")
		}
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		var lastErr error
		for _, ip := range ips {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 45 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || req.URL.Scheme != "https" || req.URL.User != nil {
			return errors.New("unsafe redirect")
		}
		return nil
	}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("remote returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > 16*1024*1024 {
		return nil, errors.New("remote log exceeds 16 MiB")
	}
	f, err := os.CreateTemp("", "logsonic-agent-*.log")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	n, err := io.Copy(f, io.LimitReader(resp.Body, 16*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if n > 16*1024*1024 {
		return nil, errors.New("remote log exceeds 16 MiB")
	}
	source := "remote:" + u.Hostname() + "/" + filepath.Base(u.Path)
	if len(source) > 200 {
		source = source[:200]
	}
	result, err := h.agentImportPath(ctx, f.Name(), source, &types.SourceOrigin{Kind: "remote", Host: u.Hostname(), Path: u.Scheme + "://" + u.Host + u.Path})
	if err != nil {
		return nil, err
	}
	return map[string]any{"url": raw, "bytes": n, "import": result}, nil
}

var blockedDownloadNets = func() []*net.IPNet {
	ranges := []string{
		"0.0.0.0/8",
		"100.64.0.0/10",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.88.99.0/24",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",
		"::/96",
		"64:ff9b::/96",
		"64:ff9b:1::/48",
		"100::/64",
		"2001::/32",
		"2001:db8::/32",
		"2002::/16",
		"fec0::/10",
	}
	out := make([]*net.IPNet, 0, len(ranges))
	for _, r := range ranges {
		_, network, _ := net.ParseCIDR(r)
		out = append(out, network)
	}
	return out
}()

func publicDownloadIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, network := range blockedDownloadNets {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

var awsSafeName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

func (h *Services) agentIngestCloudWatch(ctx context.Context, in map[string]any) (any, error) {
	profile, region, group := toolString(in, "profile"), toolString(in, "region"), toolString(in, "log_group")
	if !awsSafeName.MatchString(profile) || !awsSafeName.MatchString(region) || group == "" || len(group) > 512 {
		return nil, errors.New("explicit AWS profile, region and log group required")
	}
	args := []string{"logs", "filter-log-events", "--profile", profile, "--region", region, "--log-group-name", group, "--limit", "1000", "--no-paginate", "--output", "json"}
	for _, key := range []string{"start_time_ms", "end_time_ms"} {
		if raw, exists := in[key]; exists {
			v, ok := raw.(float64)
			if !ok || v <= 0 || v != float64(int64(v)) {
				return nil, fmt.Errorf("%s must be a positive millisecond timestamp", key)
			}
			flag := "--start-time"
			if key == "end_time_ms" {
				flag = "--end-time"
			}
			args = append(args, flag, fmt.Sprintf("%.0f", v))
		}
	}
	cmd := exec.CommandContext(ctx, "aws", args...)
	// --profile must choose credentials. Ambient AWS key variables would
	// otherwise silently override the named profile in some CLI setups.
	var env []string
	for _, v := range os.Environ() {
		key, _, _ := strings.Cut(v, "=")
		switch key {
		case "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE":
			continue
		}
		env = append(env, v)
	}
	cmd.Env = append(env, "AWS_PAGER=", "AWS_CLI_AUTO_PROMPT=off")
	var output limitedWriter
	output.limit = 8 * 1024 * 1024
	cmd.Stdout = &output
	var stderr limitedWriter
	stderr.limit = 1024
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("CloudWatch import failed: %w: %s", err, stderr.String())
	}
	if output.overflow {
		return nil, errors.New("CloudWatch response exceeds 8 MiB")
	}
	var parsed struct {
		Events []struct {
			Message   string `json:"message"`
			Timestamp int64  `json:"timestamp"`
		} `json:"events"`
		NextToken string `json:"nextToken"`
	}
	if err := json.Unmarshal(output.Bytes(), &parsed); err != nil {
		return nil, err
	}
	if len(parsed.Events) == 0 {
		return map[string]any{"source": "aws:" + group, "rows_stored": 0, "truncated": parsed.NextToken != ""}, nil
	}
	if len(parsed.Events) > 1000 {
		return nil, errors.New("CloudWatch returned more than 1000 events")
	}
	lines := make([]string, 0, len(parsed.Events))
	for _, ev := range parsed.Events {
		if len(ev.Message) > MaxIngestLineBytes {
			return nil, errors.New("CloudWatch event exceeds line limit")
		}
		if ev.Timestamp <= 0 {
			return nil, errors.New("CloudWatch event is missing its timestamp")
		}
		// AWS supplies event time separately from message text. Prefix it so
		// the shared auto decoder indexes the authoritative event time.
		lines = append(lines, time.UnixMilli(ev.Timestamp).UTC().Format(time.RFC3339Nano)+" "+strings.TrimSuffix(ev.Message, "\n"))
	}
	source := "aws:" + group
	id, startErr := newIngestSession(types.IngestSessionOptions{Name: "AUTO", Pattern: "auto", Source: source, Meta: map[string]interface{}{"_src": source}})
	if startErr != nil {
		return nil, startErr
	}
	defer h.endIngestSession(id)
	stored, failed, err := h.ingestBatch(id, lines)
	if err != nil {
		return nil, err
	}
	return map[string]any{"source": source, "rows_stored": stored, "rows_failed": failed, "truncated": parsed.NextToken != ""}, nil
}

type limitedWriter struct {
	data     []byte
	limit    int
	overflow bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	n := len(p)
	if len(w.data)+n > w.limit {
		w.overflow = true
		p = p[:max(0, w.limit-len(w.data))]
	}
	w.data = append(w.data, p...)
	return n, nil
}
func (w *limitedWriter) Bytes() []byte  { return w.data }
func (w *limitedWriter) String() string { return string(w.data) }

func (h *Services) agentQuery(ctx context.Context, in map[string]any, analyze bool) (any, error) {
	query := toolString(in, "query")
	if len(query) > 512 {
		return nil, errors.New("query too long")
	}
	start, end, err := agentTimeRange(in, "start_time", "end_time")
	if err != nil {
		return nil, err
	}
	sources := agentSources(in)
	limit := 20
	if analyze {
		limit = 200
	}
	if n, ok := in["limit"].(float64); ok && !analyze {
		limit = int(n)
		if limit < 1 {
			limit = 1
		}
		if limit > 50 {
			limit = 50
		}
	}
	page, err := h.storage.SearchPage(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: sources, Limit: limit, SortBy: "timestamp", SortOrder: "desc", SkipDistribution: true})
	if err != nil {
		return nil, err
	}
	if !analyze {
		return map[string]any{"total_count": page.TotalCount, "returned": len(page.Logs), "logs": trimAgentRows(page.Logs)}, nil
	}
	bySource := map[string]int{}
	byLevel := map[string]int{}
	byMinute := map[string]int{}
	bySourceMinute := map[string]int{}
	for _, row := range page.Logs {
		source := fmt.Sprint(row["_src"])
		bySource[source]++
		level := fmt.Sprint(row["level"])
		if level == "<nil>" {
			level = fmt.Sprint(row["severity"])
		}
		byLevel[level]++
		if ts := fmt.Sprint(row["timestamp"]); len(ts) >= 16 {
			byMinute[ts[:16]]++
			bySourceMinute[ts[:16]+" | "+source]++
		}
	}
	type ranked struct {
		Key   string `json:"key"`
		Count int    `json:"count"`
	}
	rank := func(m map[string]int) []ranked {
		out := make([]ranked, 0, len(m))
		for k, v := range m {
			out = append(out, ranked{k, v})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
		if len(out) > 20 {
			out = out[:20]
		}
		return out
	}
	samples := page.Logs
	if len(samples) > 10 {
		samples = samples[:10]
	}
	samples = trimAgentRows(samples)
	spikes := []ranked{}
	if len(byMinute) > 0 {
		mean := float64(len(page.Logs)) / float64(len(byMinute))
		for _, item := range rank(byMinute) {
			if item.Count >= 3 && float64(item.Count) >= 2*mean {
				spikes = append(spikes, item)
			}
		}
	}
	return map[string]any{"total_count": page.TotalCount, "sampled": len(page.Logs), "by_source": rank(bySource), "by_level": rank(byLevel), "top_minutes": rank(byMinute), "source_minutes": rank(bySourceMinute), "candidate_spikes": spikes, "sample_logs": samples, "note": "Counts and candidate spikes are from the newest 200 matching rows, not a full baseline; total_count is exact. Shared minutes across sources suggest temporal correlation, not causation."}, nil
}
