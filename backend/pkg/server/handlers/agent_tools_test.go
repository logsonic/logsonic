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
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.1.1", "198.18.0.1", "192.0.2.1", "2001:db8::1"} {
		if publicDownloadIP(net.ParseIP(ip)) {
			t.Errorf("accepted %s", ip)
		}
	}
	if !publicDownloadIP(net.ParseIP("8.8.8.8")) {
		t.Error("rejected public address")
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
