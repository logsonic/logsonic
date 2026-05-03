package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// MigrateLegacyGrokJSON folds any pre-existing <storagePath>/grok.json
// into log2grok's externalized library, then renames the legacy file to
// grok.json.migrated.<unix> so the migration runs only once per
// install. Existing entries in log2grok with the same Name are
// preserved (we treat them as authoritative — they may already have
// been edited via the new admin APIs).
//
// Returns nil on a no-op (file absent), nil on a successful migration,
// or a non-nil error if the legacy file is unreadable / malformed.
func MigrateLegacyGrokJSON(storagePath string) error {
	if storagePath == "" {
		return nil
	}
	legacyPath := filepath.Clean(filepath.Join(storagePath, "grok.json"))
	f, err := os.Open(legacyPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("legacy grok.json: open: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		return fmt.Errorf("legacy grok.json: read: %w", err)
	}

	var wrapper struct {
		Patterns []types.GrokPatternDefinition `json:"patterns"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return fmt.Errorf("legacy grok.json: parse: %w", err)
	}

	// Build a set of names already known to log2grok so we don't clobber
	// updated definitions during migration.
	existing := make(map[string]struct{})
	for _, kp := range l2g.ListLibrary() {
		existing[kp.Name] = struct{}{}
	}

	migrated := 0
	for _, def := range wrapper.Patterns {
		if def.Name == "" || def.Pattern == "" {
			continue
		}
		if _, ok := existing[def.Name]; ok {
			continue
		}
		_, err := l2g.UpsertLibraryEntry(l2g.KnownPattern{
			Name:           def.Name,
			Pattern:        def.Pattern,
			Priority:       def.Priority,
			Description:    def.Description,
			CustomPatterns: def.CustomPatterns,
		})
		if err != nil {
			// Don't abort the whole migration on one bad entry — log it
			// in the rename suffix and keep going. The renamed file
			// remains as a backup the operator can inspect.
			fmt.Fprintf(os.Stderr, "logsonic: skipping migration of %q: %v\n", def.Name, err)
			continue
		}
		migrated++
	}

	// Close before rename: Windows requires it; harmless on POSIX.
	_ = f.Close()

	stamp := time.Now().Unix()
	renamed := fmt.Sprintf("%s.migrated.%d", legacyPath, stamp)
	if err := os.Rename(legacyPath, renamed); err != nil {
		return fmt.Errorf("legacy grok.json: rename to %s: %w", renamed, err)
	}

	fmt.Printf("logsonic: migrated %d pattern(s) from %s -> log2grok library; backup at %s\n",
		migrated, legacyPath, renamed)
	return nil
}
