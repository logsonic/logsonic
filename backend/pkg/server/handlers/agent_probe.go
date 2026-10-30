package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const agentTestTimeout = 60 * time.Second

// agentEndpointRequest is what Settings > Agent sends to list models or test
// a connection: the fields as typed, saved or not. Empty fields fall back to
// the effective settings.
type agentEndpointRequest struct {
	Provider string `json:"provider"`
	ProxyURL string `json:"proxy_url"`
	Model    string `json:"model"`
	APIKey   string `json:"api_key"`
}

// agentRequestConfig resolves a typed request into the config to call. When
// the page switches format but leaves the endpoint empty, the default
// endpoint of that format is used, not the one saved for the other format.
// The key follows agentModelsKey: a typed key as is, a stored key only to
// the host it belongs to.
func (h *Services) agentRequestConfig(req agentEndpointRequest) (agentConfig, agentSavedSettings, error) {
	saved, _ := loadAgentSettings(h.StoragePath)
	c := resolveAgentConfig(saved)
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = c.Provider
	}
	if !validAgentProvider(provider) {
		return c, saved, errors.New("model API format must be anthropic or openai")
	}
	if provider != c.Provider {
		c.URL, c.Model = agentProviderDefaults(provider)
	}
	c.Provider = provider
	if v := strings.TrimSpace(req.ProxyURL); v != "" {
		c.URL = v
	}
	if v := strings.TrimSpace(req.Model); v != "" {
		if !validAgentText(v, 200) {
			return c, saved, errors.New("model must be at most 200 characters with no spaces")
		}
		c.Model = v
	}
	u, err := validateAgentEndpoint(c.URL, c.Provider)
	if err != nil {
		return c, saved, err
	}
	typed := strings.TrimSpace(req.APIKey)
	if typed != "" && !validAgentText(typed, 1024) {
		return c, saved, errors.New("API key must have no spaces")
	}
	c.Key = agentModelsKey(u, typed, saved)
	if c.Key == "" {
		c.Key = "local-proxy"
	}
	return c, saved, nil
}

// agentTestTool is declared on the test request so that a model or server
// without tool support fails here, not in the middle of an investigation.
var agentTestTool = map[string]any{
	"name":         "ping",
	"description":  "Returns pong. Do not call it; this request only checks the connection.",
	"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
}

// agentTestError turns an endpoint failure into advice on which field to fix.
func agentTestError(err error, cfg agentConfig) string {
	msg := err.Error()
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return "Cannot reach " + hostOf(cfg.URL) + ": " + urlErr.Err.Error() + ". Check the endpoint and that the server is running."
	}
	switch {
	case strings.Contains(msg, "HTTP 401"), strings.Contains(msg, "HTTP 403"):
		return "The endpoint rejected the API key. " + msg
	case strings.Contains(msg, "HTTP 404"):
		return "Nothing answers at this path, or the model is unknown. Check that the endpoint ends in " + agentEndpointSuffix(cfg.Provider) + " and the model name. " + msg
	case strings.Contains(msg, "HTTP 429"):
		return "The endpoint and key work, but the server is rate limiting requests or the account is out of quota. Wait and try again. " + msg
	case strings.Contains(msg, "HTTP 3"):
		return "The endpoint redirected; LogSonic does not follow redirects, so the key never reaches another host. Use the final URL. " + msg
	}
	return msg
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Host
	}
	return raw
}

// HandleAgentTest sends one short request to the endpoint with the fields
// the page has typed, so the user can check them before saving.
func (h *Services) HandleAgentTest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req agentEndpointRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeAgentError(w, http.StatusBadRequest, "invalid test request", nil)
		return
	}
	cfg, _, err := h.agentRequestConfig(req)
	if err != nil {
		writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	if cfg.Model == "" {
		writeAgentError(w, http.StatusBadRequest, "enter a model name first", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), agentTestTimeout)
	defer cancel()
	messages := []agentMessage{{Role: "user", Content: "Reply with the single word OK."}}
	tools := []map[string]any{agentTestTool}
	var httpReq *http.Request
	if cfg.Provider == agentProviderOpenAI {
		httpReq, err = openAIRequest(ctx, cfg, "You check a connection. Answer briefly.", 256, messages, tools, false)
	} else {
		httpReq, err = anthropicProxyRequest(ctx, cfg, "You check a connection. Answer briefly.", 256, messages, tools, false)
	}
	if err != nil {
		writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	start := time.Now()
	reply, err := doAgentProxy(httpReq, cfg.Provider, agentTestTimeout)
	elapsed := time.Since(start)
	if err != nil {
		if ctx.Err() != nil {
			err = errors.New("no answer within 60 seconds; a local model may still be loading, so try again")
		}
		writeAgentError(w, http.StatusBadGateway, agentTestError(err, cfg), nil)
		return
	}
	var texts []string
	for _, raw := range reply.Content {
		var b agentBlock
		if json.Unmarshal(raw, &b) == nil && b.Type == "text" {
			texts = append(texts, b.Text)
		}
	}
	text := strings.TrimSpace(strings.Join(texts, " "))
	if len(text) > 200 {
		text = text[:200] + "…"
	}
	json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"provider":    cfg.Provider,
		"model":       cfg.Model,
		"host":        hostOf(cfg.URL),
		"latency_ms":  elapsed.Milliseconds(),
		"reply":       text,
		"stop_reason": reply.StopReason,
	})
}
