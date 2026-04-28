package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"logsonic/pkg/stream"

	"github.com/google/uuid"
)

var (
	alertRules      []stream.AlertRule
	alertRulesMutex sync.Mutex
	alertsFile      = "alerts.json"
)

// loadAlertRulesFromFile reads alert rules from JSON file into memory.
func (h *Services) loadAlertRulesFromFile() error {
	alertRulesMutex.Lock()
	defer alertRulesMutex.Unlock()

	path := filepath.Clean(filepath.Join(h.StoragePath, alertsFile))
	if _, err := os.Stat(path); os.IsNotExist(err) {
		alertRules = []stream.AlertRule{}
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read alerts file: %w", err)
	}

	var payload struct {
		Rules []stream.AlertRule `json:"rules"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("parse alerts file: %w", err)
	}
	alertRules = payload.Rules
	return nil
}

func (h *Services) saveAlertRulesToFile() error {
	path := filepath.Clean(filepath.Join(h.StoragePath, alertsFile))
	payload := struct {
		Rules []stream.AlertRule `json:"rules"`
	}{Rules: alertRules}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal alerts: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// syncAlertRulesToBus pushes current in-memory rules to the stream bus.
func (h *Services) syncAlertRulesToBus() {
	if h.StreamBus == nil {
		return
	}
	h.StreamBus.SetAlertRules(alertRules)
}

// HandleAlertRules dispatches GET/POST/DELETE for /api/v1/alerts.
// @Summary Manage alert rules
// @Description CRUD for alert rules evaluated per-event in the stream bus
// @Tags alerts
// @Router /alerts [get]
// @Router /alerts [post]
// @Router /alerts/{id} [delete]
func (h *Services) HandleAlertRules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleListAlerts(w, r)
	case http.MethodPost:
		h.handleCreateAlert(w, r)
	case http.MethodDelete:
		h.handleDeleteAlert(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Services) handleListAlerts(w http.ResponseWriter, _ *http.Request) {
	alertRulesMutex.Lock()
	snapshot := make([]stream.AlertRule, len(alertRules))
	copy(snapshot, alertRules)
	alertRulesMutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"rules": snapshot})
}

func (h *Services) handleCreateAlert(w http.ResponseWriter, r *http.Request) {
	var rule stream.AlertRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		http.Error(w, fmt.Sprintf("invalid body: %v", err), http.StatusBadRequest)
		return
	}
	if rule.Name == "" || rule.Query == "" {
		http.Error(w, "name and query required", http.StatusBadRequest)
		return
	}
	rule.ID = uuid.New().String()

	alertRulesMutex.Lock()
	alertRules = append(alertRules, rule)
	if err := h.saveAlertRulesToFile(); err != nil {
		alertRulesMutex.Unlock()
		http.Error(w, fmt.Sprintf("save failed: %v", err), http.StatusInternalServerError)
		return
	}
	alertRulesMutex.Unlock()

	h.syncAlertRulesToBus()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(rule)
}

func (h *Services) handleDeleteAlert(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id query param required", http.StatusBadRequest)
		return
	}

	alertRulesMutex.Lock()
	found := false
	updated := alertRules[:0]
	for _, rule := range alertRules {
		if rule.ID == id {
			found = true
			continue
		}
		updated = append(updated, rule)
	}
	if !found {
		alertRulesMutex.Unlock()
		http.Error(w, "rule not found", http.StatusNotFound)
		return
	}
	alertRules = updated
	if err := h.saveAlertRulesToFile(); err != nil {
		alertRulesMutex.Unlock()
		http.Error(w, fmt.Sprintf("save failed: %v", err), http.StatusInternalServerError)
		return
	}
	alertRulesMutex.Unlock()

	h.syncAlertRulesToBus()

	w.WriteHeader(http.StatusNoContent)
}

// InitializeAlertRules loads alert rules from disk and syncs them to the bus.
func (h *Services) InitializeAlertRules() {
	if err := h.loadAlertRulesFromFile(); err != nil {
		fmt.Printf("alert rules: load error: %v\n", err)
	}
	h.syncAlertRulesToBus()
}
