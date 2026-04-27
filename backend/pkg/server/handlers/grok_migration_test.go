package handlers

import (
	"encoding/json"
	"logsonic/pkg/types"
	"os"
	"path/filepath"
	"testing"
)

// TestLoadPatternsFromFile_MergesNewDefaults verifies that when grok.json exists
// but is missing patterns that are now in DefaultGrokPatterns, those patterns
// are added automatically on next startup without overwriting existing entries.
func TestLoadPatternsFromFile_MergesNewDefaults(t *testing.T) {
	dir := t.TempDir()
	h := NewHandler(newMockStorage(), &mockTokenizer{}, dir)

	// Write a grok.json that has only one known pattern — simulates a file
	// from an older release that predates the BGL and other new patterns.
	oldPatterns := []types.GrokPatternDefinition{
		{
			Name:        "Syslog",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{GREEDYDATA:message}",
			Priority:    1,
			Description: "Old syslog pattern kept by user",
		},
	}
	writeGrokJSON(t, dir, oldPatterns)

	// Simulate server startup: load patterns from file.
	patternMutex.Lock()
	currentPatterns = nil
	patternMutex.Unlock()

	if err := h.loadPatternsFromFile(); err != nil {
		t.Fatalf("loadPatternsFromFile: %v", err)
	}

	patternMutex.Lock()
	loaded := make([]types.GrokPatternDefinition, len(currentPatterns))
	copy(loaded, currentPatterns)
	patternMutex.Unlock()

	// The old "Syslog" entry must still be present (user customization preserved).
	if !hasPatternName(loaded, "Syslog") {
		t.Error("existing Syslog pattern was lost after merge")
	}

	// The new BGL pattern must have been injected from defaults.
	if !hasPatternName(loaded, "IBM BGL Supercomputer") {
		t.Error("IBM BGL Supercomputer pattern was not merged from defaults")
	}

	// Total count must be 1 (old) + all defaults except Syslog (already present).
	defaults := DefaultGrokPatterns()
	wantCount := 1 // the old custom Syslog
	for _, d := range defaults {
		if d.Name != "Syslog" {
			wantCount++
		}
	}
	if len(loaded) != wantCount {
		t.Errorf("expected %d patterns after merge, got %d", wantCount, len(loaded))
	}
}

// TestLoadPatternsFromFile_ExistingPatternNotOverwritten verifies that a pattern
// whose Name matches a default is kept as-is (user version wins over default).
func TestLoadPatternsFromFile_ExistingPatternNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	h := NewHandler(newMockStorage(), &mockTokenizer{}, dir)

	customDescription := "MY CUSTOM DESCRIPTION — must survive merge"
	writeGrokJSON(t, dir, []types.GrokPatternDefinition{
		{
			Name:        "IBM BGL Supercomputer",
			Pattern:     "%{GREEDYDATA:message}", // user-overridden pattern
			Priority:    999,
			Description: customDescription,
		},
	})

	patternMutex.Lock()
	currentPatterns = nil
	patternMutex.Unlock()

	if err := h.loadPatternsFromFile(); err != nil {
		t.Fatalf("loadPatternsFromFile: %v", err)
	}

	patternMutex.Lock()
	defer patternMutex.Unlock()

	for _, p := range currentPatterns {
		if p.Name == "IBM BGL Supercomputer" {
			if p.Description != customDescription {
				t.Errorf("user-customized BGL pattern was overwritten: got description %q", p.Description)
			}
			return
		}
	}
	t.Error("IBM BGL Supercomputer not found after load")
}

// TestLoadPatternsFromFile_NoFileCreatesDefaults verifies the no-file path still
// produces the full default set (regression guard).
func TestLoadPatternsFromFile_NoFileCreatesDefaults(t *testing.T) {
	dir := t.TempDir() // empty — no grok.json
	h := NewHandler(newMockStorage(), &mockTokenizer{}, dir)

	patternMutex.Lock()
	currentPatterns = nil
	patternMutex.Unlock()

	if err := h.loadPatternsFromFile(); err != nil {
		t.Fatalf("loadPatternsFromFile: %v", err)
	}

	patternMutex.Lock()
	n := len(currentPatterns)
	patternMutex.Unlock()

	if n != len(DefaultGrokPatterns()) {
		t.Errorf("expected %d default patterns, got %d", len(DefaultGrokPatterns()), n)
	}

	// grok.json must have been created.
	if _, err := os.Stat(filepath.Join(dir, "grok.json")); err != nil {
		t.Errorf("grok.json not created: %v", err)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func writeGrokJSON(t *testing.T, dir string, patterns []types.GrokPatternDefinition) {
	t.Helper()
	payload := struct {
		Patterns []types.GrokPatternDefinition `json:"patterns"`
	}{Patterns: patterns}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "grok.json"), data, 0644); err != nil {
		t.Fatalf("write grok.json: %v", err)
	}
}

func hasPatternName(patterns []types.GrokPatternDefinition, name string) bool {
	for _, p := range patterns {
		if p.Name == name {
			return true
		}
	}
	return false
}
