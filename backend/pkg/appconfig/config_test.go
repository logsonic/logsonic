package appconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTripAndUnknownKeysSurvive(t *testing.T) {
	dir := t.TempDir()
	// A newer build (or next-10/next-11) wrote a key we don't know.
	seed := `{"version": 1, "retention_days": 30, "update_check": {"enabled": true}}`
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if d, ok := s.RetentionDays(); !ok || d != 30 {
		t.Fatalf("retention: %d %v", d, ok)
	}
	seven := 7
	if err := s.SetRetentionDays(&seven); err != nil {
		t.Fatal(err)
	}
	if err := s.SetRetentionDays(nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, fileName))
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["retention_days"]; ok {
		t.Errorf("cleared key still present: %s", b)
	}
	if string(doc["update_check"]) != `{"enabled":true}` && string(doc["update_check"]) != "{\n    \"enabled\": true\n  }" {
		t.Errorf("unknown key must survive a save: %s", b)
	}
	if string(doc["version"]) != "1" {
		t.Errorf("version: %s", doc["version"])
	}
	s2, _ := Open(dir)
	if _, ok := s2.RetentionDays(); ok {
		t.Error("cleared override came back on reload")
	}
	if keys := s2.Keys(); len(keys) != 1 || keys[0] != "update_check" {
		t.Errorf("keys: %v", keys)
	}
}

func TestMissingCorruptAndBadValues(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.RetentionDays(); ok {
		t.Fatal("missing file must mean unset")
	}
	_ = os.WriteFile(filepath.Join(dir, fileName), []byte("{not json"), 0o644)
	s, err = Open(dir)
	if err != nil || s == nil {
		t.Fatalf("corrupt file must not fail Open: %v", err)
	}
	zero := 0
	if err := s.SetRetentionDays(&zero); err != nil {
		t.Fatal(err)
	}
	if d, ok := s.RetentionDays(); !ok || d != 0 {
		t.Fatalf("0 is an explicit value, not unset: %d %v", d, ok)
	}
	neg := -1
	if err := s.SetRetentionDays(&neg); err == nil {
		t.Fatal("negative must be rejected")
	}
	_ = os.WriteFile(filepath.Join(dir, fileName), []byte(`{"version":1,"retention_days":"seven"}`), 0o644)
	s, _ = Open(dir)
	if _, ok := s.RetentionDays(); ok {
		t.Fatal("a malformed value reads as unset")
	}
}
