package stream

import "sync"

// AlertRule defines a condition to evaluate against each bus event.
type AlertRule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Query   string `json:"query"`   // Bleve-style filter; same syntax as subscriber filter
	Enabled bool   `json:"enabled"`
}

// AlertFire is emitted when an alert rule matches a published event.
type AlertFire struct {
	Rule  AlertRule
	Entry map[string]interface{}
}

// alertState is embedded in Bus to manage alert rules.
type alertState struct {
	mu    sync.RWMutex
	rules []AlertRule
}

// SetAlertRules atomically replaces the full set of active alert rules.
func (b *Bus) SetAlertRules(rules []AlertRule) {
	b.alerts.mu.Lock()
	defer b.alerts.mu.Unlock()
	b.alerts.rules = make([]AlertRule, len(rules))
	copy(b.alerts.rules, rules)
}

// GetAlertRules returns a snapshot of the current alert rules.
func (b *Bus) GetAlertRules() []AlertRule {
	b.alerts.mu.RLock()
	defer b.alerts.mu.RUnlock()
	out := make([]AlertRule, len(b.alerts.rules))
	copy(out, b.alerts.rules)
	return out
}
