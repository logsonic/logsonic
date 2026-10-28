package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/storage"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

func TestAgentCloudWatchUsesOnePageAndExplicitProfile(t *testing.T) {
	bin := t.TempDir()
	argsFile := filepath.Join(bin, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + argsFile + "'\nprintf '%s' '{\"events\":[{\"message\":\"ERROR cloud failure\",\"timestamp\":1793095200000}],\"nextToken\":\"more\"}'\n"
	if err := os.WriteFile(filepath.Join(bin, "aws"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	dir := t.TempDir()
	store, err := storage.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := l2g.LoadConfig(filepath.Join(dir, "log2grok"), os.Stderr); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(store, dir)
	out, err := h.runAgentTool(context.Background(), "ingest_cloudwatch", map[string]any{"profile": "work", "region": "eu-central-1", "log_group": "/service/checkout"})
	if err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"--profile\nwork", "--region\neu-central-1", "--no-paginate"} {
		if !strings.Contains(string(args), s) {
			t.Errorf("missing %s in %s", s, args)
		}
	}
	encoded, _ := json.Marshal(out)
	if !bytes.Contains(encoded, []byte("rows_stored")) {
		t.Errorf("output %s", encoded)
	}
	if !bytes.Contains(encoded, []byte("truncated")) {
		t.Errorf("missing truncation indicator: %s", encoded)
	}
	searched, err := h.agentQuery(context.Background(), map[string]any{"query": "cloud", "start_time": "2026-10-27T09:00:00Z", "end_time": "2026-10-27T11:00:00Z"}, false)
	if err != nil {
		t.Fatal(err)
	}
	found, _ := json.Marshal(searched)
	if !bytes.Contains(found, []byte("cloud failure")) {
		t.Errorf("CloudWatch event time was not indexed: %s", found)
	}
}

func TestAgentRemoteRejectsNonHTTPS(t *testing.T) {
	h := &Services{}
	for _, u := range []string{"http://127.0.0.1/log", "file:///etc/passwd", "https://user@example.com/log"} {
		if _, err := h.agentIngestRemote(context.Background(), u); err == nil {
			t.Errorf("accepted %s", u)
		}
	}
}

func TestAgentRemoteBlocksNonPublicAddressRanges(t *testing.T) {
	for _, ip := range []string{
		"127.0.0.1",
		"10.1.2.3",
		"169.254.169.254",
		"100.64.1.1",
		"198.18.0.1",
		"192.0.2.1",
		"192.88.99.1",
		"2001:db8::1",
		"64:ff9b::1",
		"64:ff9b:1::1",
		"2002:7f00:1::1",
		"fec0::1",
		"::ffff:100.64.0.1",
		"::ffff:127.0.0.1",
		"::7f00:1",
		"100::1",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2",
	} {
		if publicDownloadIP(net.ParseIP(ip)) {
			t.Errorf("accepted %s", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "::ffff:8.8.8.8", "2606:4700:4700::1111"} {
		if !publicDownloadIP(net.ParseIP(ip)) {
			t.Errorf("rejected public address %s", ip)
		}
	}
}

func writeAgentTestFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAgentLocalPathRefusesCredentialsButAllowsDotLogFolders(t *testing.T) {
	dir := t.TempDir()
	secret := writeAgentTestFile(t, filepath.Join(dir, ".ssh", "id_rsa"), "PRIVATE KEY\n")
	link := filepath.Join(dir, "innocent.log")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		secret,
		link,
		filepath.Join(dir, ".ssh"),
		writeAgentTestFile(t, filepath.Join(dir, ".env"), "SECRET=1\n"),
		writeAgentTestFile(t, filepath.Join(dir, "app", ".env.production"), "SECRET=1\n"),
		writeAgentTestFile(t, filepath.Join(dir, ".aws", "credentials"), "[default]\n"),
		writeAgentTestFile(t, filepath.Join(dir, ".config", "gcloud", "credentials.db"), "x"),
		writeAgentTestFile(t, filepath.Join(dir, ".docker", "config.json"), "{}"),
		writeAgentTestFile(t, filepath.Join(dir, ".netrc"), "machine x\n"),
	} {
		if _, err := validateAgentLocalPath(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	for _, good := range []string{
		writeAgentTestFile(t, filepath.Join(dir, ".ollama", "logs", "server.log"), "line\n"),
		writeAgentTestFile(t, filepath.Join(dir, ".npm", "_logs", "debug.log"), "line\n"),
		writeAgentTestFile(t, filepath.Join(dir, ".docker", "logs", "daemon.log"), "line\n"),
		writeAgentTestFile(t, filepath.Join(dir, "environment.log"), "line\n"),
	} {
		if _, err := validateAgentLocalPath(good); err != nil {
			t.Errorf("refused %s: %v", good, err)
		}
	}
}

func TestAgentLocalPathRespectsIngestRoot(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "allowed")
	inside := writeAgentTestFile(t, filepath.Join(root, "app.log"), "line\n")
	outside := writeAgentTestFile(t, filepath.Join(dir, "outside", "app.log"), "line\n")
	sibling := writeAgentTestFile(t, filepath.Join(dir, "allowed-not", "app.log"), "line\n")
	escape := filepath.Join(root, "escape.log")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGSONIC_AGENT_INGEST_ROOT", root)
	for _, bad := range []string{outside, sibling, escape} {
		if _, err := validateAgentLocalPath(bad); err == nil || !strings.Contains(err.Error(), "LOGSONIC_AGENT_INGEST_ROOT") {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
	// t.TempDir is under /var on macOS, a symlink to /private/var, so this
	// also covers a root given through a symlinked folder.
	resolved, err := validateAgentLocalPath(inside)
	if err != nil {
		t.Fatalf("refused file inside root: %v", err)
	}
	if want, _ := filepath.EvalSymlinks(inside); resolved != want {
		t.Errorf("resolved = %s, want %s", resolved, want)
	}
}

func TestAgentIngestLocalDirectorySkipsRefusedEntries(t *testing.T) {
	storeDir := t.TempDir()
	store, err := storage.NewStorage(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := l2g.LoadConfig(filepath.Join(storeDir, "log2grok"), os.Stderr); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(store, storeDir)

	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	writeAgentTestFile(t, filepath.Join(logs, "app.log"), "2026-10-28T10:00:00Z ERROR checkout failed\n")
	writeAgentTestFile(t, filepath.Join(logs, ".DS_Store"), "x")
	secret := writeAgentTestFile(t, filepath.Join(dir, ".ssh", "id_rsa"), "PRIVATE KEY\n")
	if err := os.Symlink(secret, filepath.Join(logs, "key.log")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir, filepath.Join(logs, "parent")); err != nil {
		t.Fatal(err)
	}
	out, err := h.agentIngestLocal(context.Background(), logs)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(out)
	var got struct {
		Imports []struct {
			Source string `json:"source"`
		} `json:"imports"`
		Skipped []struct {
			Name   string `json:"name"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Imports) != 1 || got.Imports[0].Source != "app.log" {
		t.Errorf("imports: %s", encoded)
	}
	skipped := map[string]bool{}
	for _, s := range got.Skipped {
		skipped[s.Name] = true
	}
	if len(got.Skipped) != 2 || !skipped["key.log"] || !skipped["parent"] {
		t.Errorf("skipped: %s", encoded)
	}

	only := filepath.Join(dir, "only-secrets")
	if err := os.MkdirAll(only, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(only, "key.log")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.agentIngestLocal(context.Background(), only); err == nil || !strings.Contains(err.Error(), "no importable files") {
		t.Errorf("err = %v", err)
	}
}

func TestAgentAnalyzeReportsCrossSourceMinuteAndCandidateSpike(t *testing.T) {
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	base := time.Now().UTC().Truncate(time.Minute).Add(-3 * time.Hour)
	for i := 0; i < 10; i++ {
		minute := 0
		if i >= 8 {
			minute = i - 7
		}
		source := "app.log"
		if i%2 == 1 {
			source = "db.log"
		}
		row := map[string]interface{}{"timestamp": base.Add(time.Duration(minute) * time.Minute), "_raw": "ERROR shared incident", "_src": source, "level": "ERROR", "_seq": int64(i)}
		if err := store.Store([]map[string]interface{}{row}, source); err != nil {
			t.Fatal(err)
		}
	}
	h := &Services{storage: store}
	out, err := h.agentQuery(context.Background(), map[string]any{"query": "ERROR"}, true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(out)
	if !bytes.Contains(encoded, []byte("candidate_spikes")) || !bytes.Contains(encoded, []byte("db.log")) || !bytes.Contains(encoded, []byte("app.log")) {
		t.Fatalf("analysis %s", encoded)
	}
}
