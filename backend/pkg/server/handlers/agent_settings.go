package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

const (
	agentDefaultProxyURL = "http://127.0.0.1:8789/v1/messages"
	agentDefaultModel    = "claude-sonnet-5-5"
	agentSettingsFile    = "agent.json"
)

// agentSavedSettings is <storage>/agent.json, written from Settings > Agent.
// The file is 0600 because it can hold an API key. Environment variables
// win over every saved value, so a launch script keeps working unchanged.
type agentSavedSettings struct {
	ProxyURL string `json:"proxy_url,omitempty"`
	Model    string `json:"model,omitempty"`
	APIKey   string `json:"api_key,omitempty"`
	// APIKeyHost is the endpoint host the key was saved for. The key is
	// sent only while the endpoint has that host, so changing the URL
	// later cannot send it to another server.
	APIKeyHost string `json:"api_key_host,omitempty"`
}

// agentConfig is the endpoint, model and key one agent request uses, with
// where each came from: "env", "saved" or "default" ("anthropic_env" and
// "none" for the key).
type agentConfig struct {
	URL, URLSource     string
	Model, ModelSource string
	Key, KeySource     string
}

var agentSettingsMu sync.Mutex

func agentSettingsPath(storageDir string) string {
	return filepath.Join(storageDir, agentSettingsFile)
}

// loadAgentSettings reads agent.json. A missing file is empty settings; an
// unreadable or corrupt one is an error the settings page shows, and agent
// requests fall back to the environment and defaults.
func loadAgentSettings(storageDir string) (agentSavedSettings, error) {
	var s agentSavedSettings
	if storageDir == "" {
		return s, nil
	}
	b, err := os.ReadFile(agentSettingsPath(storageDir))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return agentSavedSettings{}, fmt.Errorf("%s is not valid JSON: %v", agentSettingsFile, err)
	}
	return s, nil
}

func saveAgentSettings(storageDir string, s agentSavedSettings) error {
	if storageDir == "" {
		return errors.New("no storage folder")
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	path := agentSettingsPath(storageDir)
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// OpenFile keeps the mode of a leftover temp file; force 0600.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// resolveAgentConfig applies the precedence: environment, then agent.json,
// then defaults. The key order is LOGSONIC_AGENT_PROXY_KEY, the saved key
// (only for the host it was saved for), ANTHROPIC_API_KEY (only for
// https://api.anthropic.com), then a placeholder local proxies ignore.
func resolveAgentConfig(saved agentSavedSettings) agentConfig {
	c := agentConfig{URL: agentDefaultProxyURL, URLSource: "default", Model: agentDefaultModel, ModelSource: "default"}
	if v := os.Getenv("LOGSONIC_AGENT_PROXY_URL"); v != "" {
		c.URL, c.URLSource = v, "env"
	} else if saved.ProxyURL != "" {
		c.URL, c.URLSource = saved.ProxyURL, "saved"
	}
	if v := os.Getenv("LOGSONIC_AGENT_MODEL"); v != "" {
		c.Model, c.ModelSource = v, "env"
	} else if saved.Model != "" {
		c.Model, c.ModelSource = saved.Model, "saved"
	}
	u, _ := url.Parse(c.URL)
	switch {
	case os.Getenv("LOGSONIC_AGENT_PROXY_KEY") != "":
		c.Key, c.KeySource = os.Getenv("LOGSONIC_AGENT_PROXY_KEY"), "env"
	case saved.APIKey != "" && u != nil && saved.APIKeyHost != "" && strings.EqualFold(u.Host, saved.APIKeyHost):
		c.Key, c.KeySource = saved.APIKey, "saved"
	case u != nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "api.anthropic.com") && os.Getenv("ANTHROPIC_API_KEY") != "":
		c.Key, c.KeySource = os.Getenv("ANTHROPIC_API_KEY"), "anthropic_env"
	default:
		c.Key, c.KeySource = "local-proxy", "none"
	}
	return c
}

// currentAgentConfig resolves the settings for one request. A broken agent.json
// is ignored here (the settings page reports it), so the environment and
// defaults still work.
func (h *Services) currentAgentConfig() agentConfig {
	saved, _ := loadAgentSettings(h.StoragePath)
	return resolveAgentConfig(saved)
}

// validateAgentEndpoint checks a model endpoint: any server that speaks the
// Anthropic Messages API at a path ending in /v1/messages. Plain HTTP is
// allowed only on loopback (a local proxy, Ollama, LiteLLM), so an API key
// and log excerpts never cross the network unencrypted; remote endpoints
// must use HTTPS.
func validateAgentEndpoint(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || !strings.HasSuffix(u.Path, "/v1/messages") || u.User != nil {
		return nil, errors.New("the model endpoint must be an http(s) URL whose path ends in /v1/messages")
	}
	switch u.Scheme {
	case "https":
		return u, nil
	case "http":
		switch strings.ToLower(u.Hostname()) {
		case "localhost", "127.0.0.1", "::1":
			return u, nil
		}
		return nil, errors.New("plain HTTP model endpoints must be on localhost; use HTTPS for a remote endpoint")
	}
	return nil, errors.New("the model endpoint must use http (localhost only) or https")
}

func agentKeyHint(key string) string {
	if len(key) <= 8 {
		return "••••"
	}
	return "••••" + key[len(key)-4:]
}

func agentSettingsResponse(storageDir string, mcpPath string) map[string]any {
	saved, loadErr := loadAgentSettings(storageDir)
	c := resolveAgentConfig(saved)
	key := map[string]any{"source": c.KeySource, "saved": saved.APIKey != ""}
	if saved.APIKey != "" {
		key["saved_hint"] = agentKeyHint(saved.APIKey)
		key["saved_host"] = saved.APIKeyHost
	}
	out := map[string]any{
		"path":                  agentSettingsPath(storageDir),
		"proxy_url":             map[string]any{"value": c.URL, "source": c.URLSource, "saved": saved.ProxyURL, "default": agentDefaultProxyURL},
		"model":                 map[string]any{"value": c.Model, "source": c.ModelSource, "saved": saved.Model, "default": agentDefaultModel},
		"api_key":               key,
		"anthropic_api_key_env": os.Getenv("ANTHROPIC_API_KEY") != "",
		"mcp_config":            mcpPath,
		"mcp_config_in_storage": mcpPath != "" && filepath.Dir(mcpPath) == filepath.Clean(storageDir),
	}
	if loadErr != nil {
		out["error"] = loadErr.Error()
	}
	return out
}

func (h *Services) agentMCPPath() string {
	if h.AgentMCP == nil {
		return ""
	}
	return h.AgentMCP.Status().Config
}

// HandleAgentSettings reports the effective model settings and where each
// value comes from. The saved API key is never returned, only its last
// four characters and the host it is saved for.
func (h *Services) HandleAgentSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	agentSettingsMu.Lock()
	defer agentSettingsMu.Unlock()
	json.NewEncoder(w).Encode(agentSettingsResponse(h.StoragePath, h.agentMCPPath()))
}

type agentSettingsUpdate struct {
	// nil keeps the saved value; "" clears it (back to the default).
	ProxyURL *string `json:"proxy_url"`
	Model    *string `json:"model"`
	// nil keeps the saved key; a value replaces it.
	APIKey      *string `json:"api_key"`
	ClearAPIKey bool    `json:"clear_api_key"`
}

func validAgentText(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// HandleUpdateAgentSettings saves Settings > Agent to agent.json. MCP
// servers are not set here: they stay in mcp.json, edited by hand.
func (h *Services) HandleUpdateAgentSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req agentSettingsUpdate
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeAgentError(w, http.StatusBadRequest, "invalid settings body", nil)
		return
	}
	agentSettingsMu.Lock()
	defer agentSettingsMu.Unlock()
	saved, err := loadAgentSettings(h.StoragePath)
	if err != nil {
		// A corrupt file is replaced by what the page sends.
		saved = agentSavedSettings{}
	}
	if req.ProxyURL != nil {
		v := strings.TrimSpace(*req.ProxyURL)
		if v != "" {
			if _, err := validateAgentEndpoint(v); err != nil {
				writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
				return
			}
		}
		saved.ProxyURL = v
	}
	if req.Model != nil {
		v := strings.TrimSpace(*req.Model)
		if !validAgentText(v, 200) {
			writeAgentError(w, http.StatusBadRequest, "model must be at most 200 characters with no spaces", nil)
			return
		}
		saved.Model = v
	}
	if req.ClearAPIKey {
		saved.APIKey, saved.APIKeyHost = "", ""
	}
	if req.APIKey != nil {
		v := strings.TrimSpace(*req.APIKey)
		if v == "" || !validAgentText(v, 1024) {
			writeAgentError(w, http.StatusBadRequest, "API key must be non-empty with no spaces", nil)
			return
		}
		// Bind the key to the endpoint it will be used with now.
		effective := resolveAgentConfig(saved).URL
		u, err := validateAgentEndpoint(effective)
		if err != nil {
			writeAgentError(w, http.StatusBadRequest, "set a valid endpoint before saving a key: "+err.Error(), nil)
			return
		}
		saved.APIKey, saved.APIKeyHost = v, strings.ToLower(u.Host)
	}
	if err := saveAgentSettings(h.StoragePath, saved); err != nil {
		writeAgentError(w, http.StatusInternalServerError, "could not save agent settings: "+err.Error(), nil)
		return
	}
	json.NewEncoder(w).Encode(agentSettingsResponse(h.StoragePath, h.agentMCPPath()))
}
