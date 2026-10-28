package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentProxyEndpointRules(t *testing.T) {
	for url, ok := range map[string]bool{
		"http://127.0.0.1:8789/v1/messages":                 true,
		"http://localhost:11434/v1/messages":                true,
		"https://api.anthropic.com/v1/messages":             true,
		"https://gateway.example.com/anthropic/v1/messages": true,
		"http://10.0.0.5:4000/v1/messages":                  false,
		"http://gateway.example.com/v1/messages":            false,
		"https://api.anthropic.com/v1/complete":             false,
		"https://user:pw@api.anthropic.com/v1/messages":     false,
		"ftp://localhost/v1/messages":                       false,
	} {
		if _, err := validateAgentEndpoint(url); (err == nil) != ok {
			t.Errorf("%s: err=%v, want ok=%v", url, err, ok)
		}
	}
}

func clearAgentEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"LOGSONIC_AGENT_PROXY_URL", "LOGSONIC_AGENT_MODEL", "LOGSONIC_AGENT_PROXY_KEY", "ANTHROPIC_API_KEY"} {
		t.Setenv(k, "")
	}
}

func TestAgentProxyKeyFallsBackToAnthropicKeyOnlyForClaudeAPI(t *testing.T) {
	clearAgentEnv(t)
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "http://127.0.0.1:8789/v1/messages")
	if got := resolveAgentConfig(agentSavedSettings{}).Key; got != "local-proxy" {
		t.Errorf("local proxy got %q; the Anthropic key must not go to a local proxy by default", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://llm-gateway.example.com/anthropic/v1/messages")
	if got := resolveAgentConfig(agentSavedSettings{}).Key; got != "local-proxy" {
		t.Errorf("a third-party gateway got %q; the Anthropic key must only go to api.anthropic.com", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://api.anthropic.com/v1/messages")
	if got := resolveAgentConfig(agentSavedSettings{}).Key; got != "sk-test" {
		t.Errorf("Claude API endpoint got %q", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "explicit")
	if got := resolveAgentConfig(agentSavedSettings{}).Key; got != "explicit" {
		t.Errorf("explicit key got %q", got)
	}
}

func TestAgentConfigPrecedenceEnvSavedDefault(t *testing.T) {
	clearAgentEnv(t)
	c := resolveAgentConfig(agentSavedSettings{})
	if c.URL != agentDefaultProxyURL || c.URLSource != "default" || c.Model != agentDefaultModel || c.ModelSource != "default" || c.KeySource != "none" {
		t.Fatalf("defaults: %+v", c)
	}
	saved := agentSavedSettings{ProxyURL: "https://api.anthropic.com/v1/messages", Model: "claude-opus-5-5", APIKey: "sk-saved", APIKeyHost: "api.anthropic.com"}
	t.Setenv("ANTHROPIC_API_KEY", "sk-ambient")
	c = resolveAgentConfig(saved)
	if c.URL != saved.ProxyURL || c.URLSource != "saved" || c.Model != "claude-opus-5-5" || c.Key != "sk-saved" || c.KeySource != "saved" {
		t.Fatalf("saved: %+v", c)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://API.anthropic.com/v1/messages")
	t.Setenv("LOGSONIC_AGENT_MODEL", "env-model")
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "sk-env")
	c = resolveAgentConfig(saved)
	if c.URLSource != "env" || c.Model != "env-model" || c.Key != "sk-env" || c.KeySource != "env" {
		t.Fatalf("env: %+v", c)
	}
}

// A saved key goes only to the host it was saved for, so pointing the
// endpoint somewhere else later cannot leak it.
func TestAgentSavedKeyIsBoundToItsHost(t *testing.T) {
	clearAgentEnv(t)
	saved := agentSavedSettings{ProxyURL: "https://evil.example.com/v1/messages", APIKey: "sk-saved", APIKeyHost: "api.anthropic.com"}
	if c := resolveAgentConfig(saved); c.Key != "local-proxy" || c.KeySource != "none" {
		t.Fatalf("key sent to another host: %+v", c)
	}
	saved.ProxyURL = "http://127.0.0.1:4000/v1/messages"
	saved.APIKeyHost = "127.0.0.1:4000"
	if c := resolveAgentConfig(saved); c.Key != "sk-saved" {
		t.Fatalf("key not sent to its own host: %+v", c)
	}
	saved.ProxyURL = "http://127.0.0.1:4001/v1/messages"
	if c := resolveAgentConfig(saved); c.Key != "local-proxy" {
		t.Fatalf("key sent to another port: %+v", c)
	}
}

func putAgentSettings(t *testing.T, h *Services, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	h.HandleUpdateAgentSettings(w, httptest.NewRequest(http.MethodPut, "/api/v1/agent/settings", bytes.NewBufferString(body)))
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAgentSettingsSaveNeverReturnsKeyAndWrites0600(t *testing.T) {
	clearAgentEnv(t)
	dir := t.TempDir()
	h := &Services{StoragePath: dir}
	w, out := putAgentSettings(t, h, `{"proxy_url":"https://api.anthropic.com/v1/messages","model":"claude-opus-5-5","api_key":"sk-ant-secret-1234"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "sk-ant-secret") {
		t.Fatalf("response leaks the key: %s", w.Body)
	}
	key := out["api_key"].(map[string]any)
	if key["source"] != "saved" || key["saved_hint"] != "••••1234" || key["saved_host"] != "api.anthropic.com" {
		t.Fatalf("api_key = %v", key)
	}
	info, err := os.Stat(filepath.Join(dir, "agent.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("agent.json mode %v, want 0600", info.Mode().Perm())
	}
	if c := h.currentAgentConfig(); c.Key != "sk-ant-secret-1234" || c.Model != "claude-opus-5-5" {
		t.Fatalf("config %+v", c)
	}

	// Omitted fields keep their saved value; "" resets to the default.
	if w, _ := putAgentSettings(t, h, `{"model":""}`); w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if c := h.currentAgentConfig(); c.Model != agentDefaultModel || c.Key != "sk-ant-secret-1234" || c.URLSource != "saved" {
		t.Fatalf("after model reset: %+v", c)
	}

	// Moving the endpoint does not move the key.
	putAgentSettings(t, h, `{"proxy_url":"https://gateway.example.com/v1/messages"}`)
	if c := h.currentAgentConfig(); c.KeySource != "none" {
		t.Fatalf("key followed the endpoint: %+v", c)
	}
	w = httptest.NewRecorder()
	h.HandleAgentSettings(w, httptest.NewRequest(http.MethodGet, "/api/v1/agent/settings", nil))
	if strings.Contains(w.Body.String(), "sk-ant-secret") {
		t.Fatalf("GET leaks the key: %s", w.Body)
	}

	putAgentSettings(t, h, `{"clear_api_key":true}`)
	if saved, _ := loadAgentSettings(dir); saved.APIKey != "" || saved.APIKeyHost != "" {
		t.Fatalf("key not cleared: %+v", saved)
	}
}

func TestAgentSettingsRejectsBadInput(t *testing.T) {
	clearAgentEnv(t)
	h := &Services{StoragePath: t.TempDir()}
	for _, body := range []string{
		`{"proxy_url":"http://gateway.example.com/v1/messages"}`,
		`{"proxy_url":"https://api.anthropic.com/v1/complete"}`,
		`{"model":"two words"}`,
		`{"api_key":"sk with space"}`,
		`{"api_key":"sk\r\nX-Injected: 1"}`,
		`{"api_key":""}`,
		`{"mcp":{"command":"sh"}}`,
		`not json`,
	} {
		if w, _ := putAgentSettings(t, h, body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", body, w.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(h.StoragePath, "agent.json")); err == nil {
		t.Error("a rejected update wrote agent.json")
	}
}

func TestAgentConfigIgnoresCorruptSettingsFile(t *testing.T) {
	clearAgentEnv(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &Services{StoragePath: dir}
	if c := h.currentAgentConfig(); c.URL != agentDefaultProxyURL {
		t.Fatalf("config %+v", c)
	}
	w := httptest.NewRecorder()
	h.HandleAgentSettings(w, httptest.NewRequest(http.MethodGet, "/api/v1/agent/settings", nil))
	if !strings.Contains(w.Body.String(), "not valid JSON") {
		t.Fatalf("settings page not told about the corrupt file: %s", w.Body)
	}
	if w, _ := putAgentSettings(t, h, `{"model":"claude-opus-5-5"}`); w.Code != http.StatusOK {
		t.Fatalf("could not overwrite corrupt file: %d", w.Code)
	}
}
