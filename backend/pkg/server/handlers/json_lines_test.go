package handlers

import (
	"fmt"
	"testing"

	"logsonic/pkg/types"
)

func TestJSONLineFields(t *testing.T) {
	fields, ok := jsonLineFields(`{"timestamp":"2026-10-27T08:05:55.000Z","pid":57725,"ok":true,"gone":null,"http":{"status":200,"req":{"path":"/a"}},"tags":["a","b"],"_src":"spoofed","amount":12.50,"a.b":"dot"}`)
	if !ok {
		t.Fatal("valid object rejected")
	}
	want := map[string]string{"timestamp": "2026-10-27T08:05:55.000Z", "pid": "57725", "ok": "true", "http_status": "200", "http_req_path": "/a", "tags": `["a","b"]`, "json_src": "spoofed", "amount": "12.50", "a_b": "dot"}
	if len(fields) != len(want) {
		t.Fatalf("fields = %v", fields)
	}
	for k, v := range want {
		if fields[k] != v {
			t.Errorf("%s = %q, want %q", k, fields[k], v)
		}
	}
	for _, bad := range []string{"plain text", `{"a":1} trailing`, `{"a":`, `[1,2]`, `{}`} {
		if _, ok := jsonLineFields(bad); ok {
			t.Errorf("jsonLineFields(%q) accepted", bad)
		}
	}
}

// JSON lines whose key sets vary (session lines lack src_ip) can make
// discovery prefer an inferred text pattern; auto import must still store
// every line with its JSON fields.
func TestAutoImportDecodesVaryingJSONLines(t *testing.T) {
	lines := []string{}
	for i := 0; i < 60; i++ {
		lines = append(lines,
			fmt.Sprintf(`{"timestamp":"2026-10-27T08:%02d:00.000Z","level":"INFO","service":"sshd","message":"Accepted publickey for deploy from 10.0.4.%d port 4%04d ssh2","host":"bastion-01","pid":%d,"user":"deploy","src_ip":"10.0.4.%d","auth_method":"publickey","event":"login_success"}`, i, i, i, 1000+i, i),
			fmt.Sprintf(`{"timestamp":"2026-10-27T08:%02d:01.000Z","level":"INFO","service":"sshd","message":"pam_unix(sshd:session): session opened for user deploy(uid=1000) by (uid=0)","host":"bastion-01","pid":%d,"user":"deploy","event":"session_open"}`, i, 1000+i))
	}
	session := IngestSession{AutoDetect: true, Adaptive: newAdaptiveDecoder(false), Options: types.IngestSessionOptions{Name: "AUTO", Pattern: "auto", Source: "auth.jsonl"}}
	results, _ := decodeSessionRecords(session, lines)
	for i, r := range results {
		if !r.Matched || r.Fields["user"] != "deploy" || r.Fields["event"] == "" || r.Fields["level"] != "INFO" {
			t.Fatalf("line %d (%s) fields = %v", i, r.Pattern, r.Fields)
		}
		if i%2 == 0 && r.Fields["src_ip"] == "" && r.Fields["client_ip"] == "" {
			t.Fatalf("line %d lost its address: %v", i, r.Fields)
		}
	}
}
