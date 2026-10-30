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
	agentDefaultProxyURL  = "http://127.0.0.1:8789/v1/messages"
	agentDefaultModel     = "claude-sonnet-5-5"
	agentDefaultOpenAIURL = "https://api.openai.com/v1/chat/completions"
	agentSettingsFile     = "agent.json"
)

// The two request formats the agent can speak. "anthropic" is the Messages
// API (…/v1/messages); "openai" is Chat Completions (…/chat/completions),
// which OpenAI, Ollama, LiteLLM, vLLM, OpenRouter and most gateways serve.
const (
	agentProviderAnthropic = "anthropic"
	agentProviderOpenAI    = "openai"
)

func validAgentProvider(p string) bool {
	return p == agentProviderAnthropic || p == agentProviderOpenAI
}

// agentEndpointSuffix is the path an endpoint of each format must end with.
func agentEndpointSuffix(provider string) string {
	if provider == agentProviderOpenAI {
		return "/chat/completions"
	}
	return "/v1/messages"
}

// agentProviderDefaults is the endpoint and model an unset config resolves
// to. OpenAI-compatible servers have no model every one of them knows, so
// that default is empty and the status asks the user to pick one.
func agentProviderDefaults(provider string) (endpoint, model string) {
	if provider == agentProviderOpenAI {
		return agentDefaultOpenAIURL, ""
	}
	return agentDefaultProxyURL, agentDefaultModel
}

// agentSavedSettings is <storage>/agent.json, written from Settings > Agent.
// The file is 0600 because it can hold an API key. Environment variables
// win over every saved value, so a launch script keeps working unchanged.
type agentSavedSettings struct {
	// Provider is the request format: "anthropic" (the default) or "openai".
	Provider string `json:"provider,omitempty"`
	ProxyURL string `json:"proxy_url,omitempty"`
	Model    string `json:"model,omitempty"`
	APIKey   string `json:"api_key,omitempty"`
	// APIKeyHost is the endpoint host the key was saved for. The key is
	// sent only while the endpoint has that host, so changing the URL
	// later cannot send it to another server.
	APIKeyHost string `json:"api_key_host,omitempty"`
}

// agentConfig is the format, endpoint, model and key one agent request uses,
// with where each came from: "env", "saved" or "default" ("anthropic_env",
// "openai_env" and "none" for the key).
type agentConfig struct {
	Provider, ProviderSource string
	URL, URLSource           string
	Model, ModelSource       string
	Key, KeySource           string
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
// https://api.anthropic.com), OPENAI_API_KEY (only for https://api.openai.com),
// then a placeholder local proxies ignore.
func resolveAgentConfig(saved agentSavedSettings) agentConfig {
	c := agentConfig{Provider: agentProviderAnthropic, ProviderSource: "default"}
	if v := os.Getenv("LOGSONIC_AGENT_PROVIDER"); v != "" {
		c.Provider, c.ProviderSource = strings.ToLower(v), "env"
	} else if validAgentProvider(saved.Provider) {
		c.Provider, c.ProviderSource = saved.Provider, "saved"
	}
	c.URL, c.Model = agentProviderDefaults(c.Provider)
	c.URLSource, c.ModelSource = "default", "default"
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
	case u != nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "api.openai.com") && os.Getenv("OPENAI_API_KEY") != "":
		c.Key, c.KeySource = os.Getenv("OPENAI_API_KEY"), "openai_env"
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

// validateAgentEndpoint checks a model endpoint for a request format: the
// Anthropic Messages API at a path ending in /v1/messages, or OpenAI Chat
// Completions at a path ending in /chat/completions. Plain HTTP is allowed
// only on loopback (a local proxy, Ollama, LiteLLM), so an API key and log
// excerpts never cross the network unencrypted; remote endpoints must use
// HTTPS.
func validateAgentEndpoint(raw, provider string) (*url.URL, error) {
	if !validAgentProvider(provider) {
		return nil, fmt.Errorf("unknown model API format %q; use anthropic or openai", provider)
	}
	suffix := agentEndpointSuffix(provider)
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || !strings.HasSuffix(u.Path, suffix) || u.User != nil {
		return nil, fmt.Errorf("the model endpoint must be an http(s) URL whose path ends in %s", suffix)
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

// agentSameOrigin reports whether a request comes from LogSonic's own page.
// Browsers send no Origin on a same-origin GET, and an Origin equal to the
// Host otherwise. Any other localhost page (a dev server, a local tool) has
// a different origin and is refused the saved key.
func agentSameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

// agentSettingsResponse reports the effective settings. The saved key itself
// is included only when reveal is true (a same-origin request from
// LogSonic's own page); otherwise only its last four characters.
func agentSettingsResponse(storageDir string, mcpPath string, reveal bool) map[string]any {
	saved, loadErr := loadAgentSettings(storageDir)
	c := resolveAgentConfig(saved)
	key := map[string]any{"source": c.KeySource, "saved": saved.APIKey != "", "revealable": reveal}
	if saved.APIKey != "" {
		key["saved_hint"] = agentKeyHint(saved.APIKey)
		key["saved_host"] = saved.APIKeyHost
		if reveal {
			key["saved_value"] = saved.APIKey
		}
	}
	defaultURL, defaultModel := agentProviderDefaults(c.Provider)
	out := map[string]any{
		"path":                  agentSettingsPath(storageDir),
		"provider":              map[string]any{"value": c.Provider, "source": c.ProviderSource, "saved": saved.Provider, "default": agentProviderAnthropic},
		"proxy_url":             map[string]any{"value": c.URL, "source": c.URLSource, "saved": saved.ProxyURL, "default": defaultURL},
		"model":                 map[string]any{"value": c.Model, "source": c.ModelSource, "saved": saved.Model, "default": defaultModel},
		"api_key":               key,
		"anthropic_api_key_env": os.Getenv("ANTHROPIC_API_KEY") != "",
		"openai_api_key_env":    os.Getenv("OPENAI_API_KEY") != "",
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
// value comes from. The saved API key is returned only to LogSonic's own
// page (same origin), so the settings form can show it; any other origin
// gets its last four characters and the host it is saved for.
func (h *Services) HandleAgentSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	agentSettingsMu.Lock()
	defer agentSettingsMu.Unlock()
	json.NewEncoder(w).Encode(agentSettingsResponse(h.StoragePath, h.agentMCPPath(), agentSameOrigin(r)))
}

type agentSettingsUpdate struct {
	// nil keeps the saved value; "" clears it (back to the default).
	Provider *string `json:"provider"`
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
	if req.Provider != nil {
		v := strings.TrimSpace(*req.Provider)
		if v != "" && !validAgentProvider(v) {
			writeAgentError(w, http.StatusBadRequest, "model API format must be anthropic or openai", nil)
			return
		}
		saved.Provider = v
	}
	provider := resolveAgentConfig(saved).Provider
	if req.ProxyURL != nil {
		v := strings.TrimSpace(*req.ProxyURL)
		if v != "" {
			if _, err := validateAgentEndpoint(v, provider); err != nil {
				writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
				return
			}
		}
		saved.ProxyURL = v
	}
	// A format change must come with an endpoint of that format, or the
	// saved one must already fit it.
	if c := resolveAgentConfig(saved); c.URLSource == "saved" {
		if _, err := validateAgentEndpoint(c.URL, c.Provider); err != nil {
			writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
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
		effective := resolveAgentConfig(saved)
		u, err := validateAgentEndpoint(effective.URL, effective.Provider)
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
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(agentSettingsResponse(h.StoragePath, h.agentMCPPath(), agentSameOrigin(r)))
}
