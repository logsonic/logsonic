package handlers

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"logsonic/pkg/appconfig"
)

// retentionInterval is how often the sweep re-runs after the one at start.
// A var so a test can shrink it.
var retentionInterval = 24 * time.Hour

// maxRetentionDays bounds PUT /storage; ten years is "keep everything" in
// practice and a larger number is a typo.
const maxRetentionDays = 3650

// RetentionManager decides how many days of logs to keep and applies it.
// Precedence (spec now-10, documented in docs/configuration.md): the
// override in <storage>/config.json (set from the UI) beats the CLI flag,
// which beats the RETENTION_DAYS env (main.go resolves flag vs env into
// defaultDays before the server starts). 0 from any source keeps everything.
type RetentionManager struct {
	defaultDays int
	cfg         *appconfig.Store
	services    *Services

	mu sync.Mutex // serializes prunes (startup, daily, PUT)
}

// NewRetentionManager wires the manager into svc (svc.Retention).
func NewRetentionManager(svc *Services, cfg *appconfig.Store, defaultDays int) *RetentionManager {
	if defaultDays < 0 {
		defaultDays = 0
	}
	m := &RetentionManager{defaultDays: defaultDays, cfg: cfg, services: svc}
	svc.Retention = m
	return m
}

// Effective returns the retention in force and its source.
func (m *RetentionManager) Effective() (days int, source string) {
	if m.cfg != nil {
		if d, ok := m.cfg.RetentionDays(); ok {
			return d, "config"
		}
	}
	if m.defaultDays > 0 {
		return m.defaultDays, "flag"
	}
	return 0, "none"
}

// Default is the flag/env value the override falls back to.
func (m *RetentionManager) Default() int { return m.defaultDays }

// Set stores the override (nil clears it) and prunes immediately so the
// caller sees the effect in the same response. Validation is the caller's
// (range) plus the store's (sign). Prunes are serialized (PruneNow's mutex);
// Set itself is not, so two concurrent PUTs each prune at whichever value
// was saved last — the user asked for both, and the file always reflects
// the later write.
func (m *RetentionManager) Set(days *int) error {
	if m.cfg == nil {
		return fmt.Errorf("config.json unavailable")
	}
	if err := m.cfg.SetRetentionDays(days); err != nil {
		return err
	}
	m.PruneNow()
	return nil
}

// PruneNow deletes every day-index older than the effective retention and
// reconciles the catalog for the days that could have gone. Safe to call
// from anywhere; it is the startup sweep, the daily tick, and the PUT.
func (m *RetentionManager) PruneNow() {
	m.mu.Lock()
	defer m.mu.Unlock()
	days, source := m.Effective()
	if days <= 0 {
		return
	}
	maxAge := time.Duration(days) * 24 * time.Hour
	cutoff := time.Now().Add(-maxAge)
	removed, err := m.services.storage.PruneOlderThan(maxAge)
	if err != nil {
		log.Printf("retention: prune failed: %v", err)
		return
	}
	if removed == 0 {
		return
	}
	log.Printf("retention: removed %d index(es) older than %d day(s) (%s)", removed, days, source)
	if c := m.services.Catalog; c != nil {
		if err := c.Rebuild(c.DaysBefore(cutoff)...); err != nil {
			log.Printf("retention: catalog rebuild failed: %v", err)
		}
	}
	m.services.InvalidateInfoCache()
}

// Start logs which source won, sweeps once, then once per retentionInterval
// until ctx is cancelled.
func (m *RetentionManager) Start(ctx context.Context) {
	days, source := m.Effective()
	switch {
	case source == "config" && m.defaultDays > 0 && days != m.defaultDays:
		log.Printf("retention: %d day(s) from config.json, overriding -retention-days %d", days, m.defaultDays)
	case source == "config":
		log.Printf("retention: %d day(s) from config.json", days)
	case source == "flag":
		log.Printf("retention: %d day(s) from -retention-days / RETENTION_DAYS", days)
	}
	m.PruneNow()
	go func() {
		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.PruneNow()
			}
		}
	}()
}
