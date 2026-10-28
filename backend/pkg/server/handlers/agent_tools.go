package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

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
	default:
		if h.AgentUITools != nil && strings.HasPrefix(name, "ui_") {
			return h.AgentUITools.Call(ctx, name, in)
		}
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

func (h *Services) agentIngestLocal(ctx context.Context, path string) (any, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("absolute path required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	paths := []string{path}
	if info.IsDir() {
		dir, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		entries, readErr := dir.ReadDir(129)
		dir.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, readErr
		}
		if len(entries) > 128 {
			return nil, errors.New("directory has more than 128 entries")
		}
		paths = nil
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			if len(paths) >= 16 {
				return nil, errors.New("directory has more than 16 files")
			}
			paths = append(paths, filepath.Join(path, entry.Name()))
		}
		if len(paths) == 0 {
			return nil, errors.New("directory has no files")
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
	return map[string]any{"imports": results}, nil
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
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
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
	ranges := []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001:db8::/32"}
	out := make([]*net.IPNet, 0, len(ranges))
	for _, r := range ranges {
		_, network, _ := net.ParseCIDR(r)
		out = append(out, network)
	}
	return out
}()

func publicDownloadIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
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
