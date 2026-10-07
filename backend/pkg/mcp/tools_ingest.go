package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const (
	defaultIngestWait = 20 * time.Second
	// maxIngestWait stays under the 30s HTTP client timeout an MCP client
	// typically allows per call; longer imports are polled with
	// ingest_status.
	maxIngestWait   = 25 * time.Second
	ingestPollEvery = 500 * time.Millisecond
)

type ingestJob struct {
	JobID      string `json:"job_id"`
	SessionID  string `json:"session_id"`
	Path       string `json:"path"`
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
	Lines      int64  `json:"lines"`
	RowsStored int64  `json:"rows_stored"`
	RowsFailed int64  `json:"rows_failed"`
}

func (j ingestJob) finished() bool {
	return j.State == "done" || j.State == "cancelled" || j.State == "error"
}

func waitArg(req mcp.CallToolRequest) time.Duration {
	secs := req.GetFloat("wait_seconds", defaultIngestWait.Seconds())
	if secs < 0 {
		secs = 0
	}
	d := time.Duration(secs * float64(time.Second))
	if d > maxIngestWait {
		d = maxIngestWait
	}
	return d
}

// findJob returns the job and its raw JSON from GET /ingest/jobs.
func (c *client) findJob(jobID string) (ingestJob, json.RawMessage, error) {
	data, err := c.get("/ingest/jobs", nil)
	if err != nil {
		return ingestJob{}, nil, err
	}
	var list struct {
		Jobs []json.RawMessage `json:"jobs"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return ingestJob{}, nil, err
	}
	for _, raw := range list.Jobs {
		var j ingestJob
		if json.Unmarshal(raw, &j) == nil && j.JobID == jobID {
			return j, raw, nil
		}
	}
	return ingestJob{}, nil, fmt.Errorf("ingest job %s not found (finished jobs age out after a while)", jobID)
}

// waitJob polls until the job finishes or wait elapses. A finished job's
// session is ended here, so a stateless agent never has to track it.
func (c *client) waitJob(ctx context.Context, jobID string, wait time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(wait)
	for {
		job, raw, err := c.findJob(jobID)
		if err != nil {
			return nil, err
		}
		if job.finished() || !time.Now().Before(deadline) {
			out := map[string]any{"job": raw, "finished": job.finished()}
			if job.finished() {
				if job.SessionID != "" {
					_, _ = c.post("/ingest/end", map[string]string{"session_id": job.SessionID})
				}
				if job.State == "done" {
					out["next"] = "Query with query_logs / log_facets, or show it with ui_show_view (source filter = the ingested source)."
				}
			} else {
				out["next"] = "Still running: call ingest_status with this job_id to keep waiting."
			}
			return out, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(ingestPollEvery):
		}
	}
}

// sessionOptions builds the /ingest/start body from the shared
// source/pattern arguments.
func sessionOptions(req mcp.CallToolRequest, defaultSource string) (map[string]any, string, error) {
	source := strings.TrimSpace(req.GetString("source", ""))
	if source == "" {
		source = defaultSource
	}
	if source == "" {
		return nil, "", fmt.Errorf("source is required")
	}
	opts := map[string]any{
		"source": source,
		"meta":   map[string]any{"_src": source},
	}
	name := strings.TrimSpace(req.GetString("pattern_name", ""))
	pattern := strings.TrimSpace(req.GetString("pattern", ""))
	switch {
	case pattern != "":
		opts["pattern"] = pattern
		if name == "" {
			name = "mcp-" + source
		}
		opts["name"] = name
	case name != "":
		opts["name"] = name
	default:
		// Same default as `logsonic open`: detect the format from the data.
		opts["pattern"] = "auto"
	}
	custom, err := stringMap(req, "custom_patterns")
	if err != nil {
		return nil, "", err
	}
	if len(custom) > 0 {
		opts["custom_patterns"] = custom
	}
	if req.GetBool("smart_decoder", false) {
		opts["smart_decoder"] = true
	}
	if tz := strings.TrimSpace(req.GetString("timezone", "")); tz != "" {
		opts["force_timezone"] = tz
	}
	return opts, source, nil
}

func (c *client) startSession(opts map[string]any) (string, error) {
	data, err := c.post("/ingest/start", opts)
	if err != nil {
		return "", err
	}
	var resp struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(data, &resp); err != nil || resp.SessionID == "" {
		return "", fmt.Errorf("no session id in /ingest/start response: %s", string(data))
	}
	return resp.SessionID, nil
}

func jsonResult(v any) *mcp.CallToolResult {
	b, err := json.Marshal(v)
	if err != nil {
		return resultErr(err)
	}
	return mcp.NewToolResultText(string(b))
}

var patternArgs = []mcp.ToolOption{
	mcp.WithString("pattern_name", mcp.Description("Name of a saved Grok pattern (list_grok_patterns). Omit both pattern_name and pattern to auto-detect the format.")),
	mcp.WithString("pattern", mcp.Description("Inline Grok pattern to parse with, e.g. '%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}'. Test it first with test_grok_pattern.")),
	mcp.WithObject("custom_patterns", mcp.Description("Named sub-patterns the pattern uses, e.g. {\"MYLEVEL\":\"(?:DEBUG|INFO)\"}")),
	mcp.WithBoolean("smart_decoder", mcp.Description("Also extract key=value / JSON fields from the message")),
	mcp.WithString("timezone", mcp.Description("IANA timezone for timestamps without an offset, e.g. Europe/Zurich")),
}

func withOpts(base []mcp.ToolOption, extra ...mcp.ToolOption) []mcp.ToolOption {
	out := append([]mcp.ToolOption{}, base...)
	return append(out, extra...)
}

func registerIngestTools(s *server.MCPServer, c *client) {
	// ------------------------------------------------------------ ingest_file
	s.AddTool(mcp.NewTool("ingest_file", withOpts([]mcp.ToolOption{
		mcp.WithDescription("Import a log file from the LogSonic server's disk (absolute path; .gz/.zst/.bz2 work). " +
			"Starts an ingest session, runs the import as a background job and waits up to wait_seconds for it. " +
			"Returns the job (state running|done|cancelled|error, lines, rows_stored, rows_failed). " +
			"If finished=false, poll ingest_status with the job_id. Format is auto-detected unless pattern/pattern_name is given; " +
			"preview_file + test_grok_pattern let you check the parse first."),
		mcp.WithString("path", mcp.Required(), mcp.Description("Absolute path of the file on the machine running LogSonic")),
		mcp.WithString("source", mcp.Description("Source name to store rows under (_src). Default: the file's base name")),
		mcp.WithBoolean("include_rotated", mcp.Description("Also import rotated siblings (app.log.1, app-2025-01-01.log, ...), oldest first")),
		mcp.WithNumber("wait_seconds", mcp.Description("How long to wait for the job, 0-25 (default 20)")),
	}, patternArgs...)...), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path, err := requiredString(req, "path")
		if err != nil {
			return resultErr(err), nil
		}
		opts, _, err := sessionOptions(req, filepath.Base(path))
		if err != nil {
			return resultErr(err), nil
		}
		sessionID, err := c.startSession(opts)
		if err != nil {
			return resultErr(err), nil
		}
		data, err := c.post("/ingest/file", map[string]any{
			"session_id":      sessionID,
			"path":            path,
			"include_rotated": req.GetBool("include_rotated", false),
		})
		if err != nil {
			_, _ = c.post("/ingest/end", map[string]string{"session_id": sessionID})
			return resultErr(err), nil
		}
		var accepted struct {
			JobID string `json:"job_id"`
		}
		if err := json.Unmarshal(data, &accepted); err != nil || accepted.JobID == "" {
			return resultErr(fmt.Errorf("no job id in /ingest/file response: %s", string(data))), nil
		}
		out, err := c.waitJob(ctx, accepted.JobID, waitArg(req))
		if err != nil {
			return resultErr(err), nil
		}
		out["source"] = opts["source"]
		return jsonResult(out), nil
	})

	// ---------------------------------------------------------- ingest_status
	s.AddTool(mcp.NewTool("ingest_status",
		mcp.WithDescription("Get (and optionally wait for) one import job started by ingest_file, import_sample or reimport_source."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job id returned by the import tool")),
		mcp.WithNumber("wait_seconds", mcp.Description("How long to wait for it to finish, 0-25 (default 20)")),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := requiredString(req, "job_id")
		if err != nil {
			return resultErr(err), nil
		}
		out, err := c.waitJob(ctx, jobID, waitArg(req))
		if err != nil {
			return resultErr(err), nil
		}
		return jsonResult(out), nil
	})

	// ------------------------------------------------------- list_ingest_jobs
	s.AddTool(mcp.NewTool("list_ingest_jobs",
		mcp.WithDescription("List file import jobs of this server run, running and recently finished."),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := c.get("/ingest/jobs", nil)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ------------------------------------------------------ cancel_ingest_job
	s.AddTool(mcp.NewTool("cancel_ingest_job",
		mcp.WithDescription("Cancel a running import job. Rows already stored stay."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job id")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := requiredString(req, "job_id")
		if err != nil {
			return resultErr(err), nil
		}
		data, err := c.do("DELETE", "/ingest/jobs/"+url.PathEscape(jobID), nil, nil)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ----------------------------------------------------------- ingest_lines
	s.AddTool(mcp.NewTool("ingest_lines", withOpts([]mcp.ToolOption{
		mcp.WithDescription("Ingest log lines sent inline (no file needed): parse them with the pattern (or auto-detect) and store them under source. " +
			"Use for logs the agent fetched from elsewhere (kubectl logs, an API, a pasted snippet). Up to a few thousand lines per call; call repeatedly for more."),
		mcp.WithArray("lines", mcp.Required(), mcp.WithStringItems(), mcp.Description("Raw log lines, one record per element (multi-line records are folded by the pattern's multiline rules)")),
		mcp.WithString("source", mcp.Required(), mcp.Description("Source name to store rows under (_src)")),
	}, patternArgs...)...), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		lines, err := stringList(req, "lines")
		if err != nil {
			return resultErr(err), nil
		}
		// stringList trims and drops blanks, right for names but not for log
		// lines; re-read raw strings when sent as an array.
		if raw, ok := req.GetArguments()["lines"].([]any); ok {
			lines = lines[:0]
			for _, item := range raw {
				if s, ok := item.(string); ok {
					lines = append(lines, s)
				}
			}
		}
		if len(lines) == 0 {
			return resultErr(fmt.Errorf("lines is required")), nil
		}
		opts, source, err := sessionOptions(req, "")
		if err != nil {
			return resultErr(err), nil
		}
		sessionID, err := c.startSession(opts)
		if err != nil {
			return resultErr(err), nil
		}
		data, err := c.post("/ingest/logs", map[string]any{"session_id": sessionID, "logs": lines})
		_, _ = c.post("/ingest/end", map[string]string{"session_id": sessionID})
		if err != nil {
			return resultErr(err), nil
		}
		var full map[string]any
		if json.Unmarshal(data, &full) != nil {
			return resultText(data), nil
		}
		full["source"] = source
		return jsonResult(full), nil
	})

	// ----------------------------------------------------------- preview_file
	s.AddTool(mcp.NewTool("preview_file",
		mcp.WithDescription("Read the first lines of a file on the LogSonic server's disk without importing it, to check the format before ingest_file. Feed the lines to test_grok_pattern."),
		mcp.WithString("path", mcp.Required(), mcp.Description("Absolute path")),
		mcp.WithNumber("lines", mcp.Description("How many lines (default 100)")),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path, err := requiredString(req, "path")
		if err != nil {
			return resultErr(err), nil
		}
		// Agents get 100 lines unless they ask for more; the endpoint's own
		// default (1000, sized for pattern detection) would flood the
		// agent's context.
		payload := map[string]any{"path": path, "lines": 100}
		if n := req.GetInt("lines", 0); n > 0 {
			payload["lines"] = n
		}
		data, err := c.post("/parse/preview-file", payload)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ----------------------------------------------------------- list_samples
	s.AddTool(mcp.NewTool("list_samples",
		mcp.WithDescription("List the sample log files bundled with LogSonic (handy for demos and for trying the tools on an empty install)."),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := c.get("/samples", nil)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ---------------------------------------------------------- import_sample
	s.AddTool(mcp.NewTool("import_sample",
		mcp.WithDescription("Import one bundled sample (list_samples) and wait for the job."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Sample name")),
		mcp.WithNumber("wait_seconds", mcp.Description("How long to wait for the job, 0-25 (default 20)")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return resultErr(err), nil
		}
		data, err := c.post("/samples/"+url.PathEscape(name)+"/import", map[string]any{})
		if err != nil {
			return resultErr(err), nil
		}
		var accepted struct {
			JobID string `json:"job_id"`
		}
		if err := json.Unmarshal(data, &accepted); err != nil || accepted.JobID == "" {
			return resultText(data), nil
		}
		out, err := c.waitJob(ctx, accepted.JobID, waitArg(req))
		if err != nil {
			return resultErr(err), nil
		}
		return jsonResult(out), nil
	})

	// -------------------------------------------------------------- tail_file
	s.AddTool(mcp.NewTool("tail_file", withOpts([]mcp.ToolOption{
		mcp.WithDescription("Follow a growing log file live (like tail -f): new lines are parsed, stored under source and streamed to the UI. Returns a source_id for stop_tail. For a whole folder use create_watch."),
		mcp.WithString("path", mcp.Required(), mcp.Description("Absolute path of the file to follow")),
		mcp.WithString("source", mcp.Description("Source name (default: the file's base name)")),
	}, patternArgs...)...), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path, err := requiredString(req, "path")
		if err != nil {
			return resultErr(err), nil
		}
		opts, _, err := sessionOptions(req, filepath.Base(path))
		if err != nil {
			return resultErr(err), nil
		}
		// A live source compiles its pattern at start; auto-detect is an
		// import-time feature, so fall back to the server default.
		if opts["pattern"] == "auto" {
			delete(opts, "pattern")
		}
		data, err := c.post("/live/files", map[string]any{"path": path, "options": opts})
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// -------------------------------------------------------------- stop_tail
	s.AddTool(mcp.NewTool("stop_tail",
		mcp.WithDescription("Stop following a file started with tail_file. Stored rows stay."),
		mcp.WithString("source_id", mcp.Required(), mcp.Description("source_id returned by tail_file")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := requiredString(req, "source_id")
		if err != nil {
			return resultErr(err), nil
		}
		data, err := c.do("DELETE", "/live/sources/"+url.PathEscape(id), nil, nil)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})
}
