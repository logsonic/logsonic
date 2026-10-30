package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	agentModelsTimeout  = 10 * time.Second
	agentModelsMaxBody  = 4 << 20
	agentModelsMaxPages = 5
	agentModelsMax      = 500
)

type agentModel struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// agentModelsKey picks the key for listing models at endpoint u. A key the
// page sends is the user's own, typed next to that URL. Otherwise a stored
// key goes only where the agent would send it anyway: the saved key to its
// host, LOGSONIC_AGENT_PROXY_KEY to the configured endpoint's host, and
// ANTHROPIC_API_KEY to https://api.anthropic.com and OPENAI_API_KEY to
// https://api.openai.com. The page can name any URL, so no stored key may
// follow it elsewhere.
func agentModelsKey(u *url.URL, typed string, saved agentSavedSettings) string {
	if typed != "" {
		return typed
	}
	host := strings.ToLower(u.Host)
	if v := os.Getenv("LOGSONIC_AGENT_PROXY_KEY"); v != "" {
		if cfg, err := url.Parse(resolveAgentConfig(saved).URL); err == nil && strings.EqualFold(cfg.Host, host) {
			return v
		}
	}
	if saved.APIKey != "" && strings.EqualFold(saved.APIKeyHost, host) {
		return saved.APIKey
	}
	if u.Scheme == "https" && strings.EqualFold(u.Hostname(), "api.anthropic.com") {
		return os.Getenv("ANTHROPIC_API_KEY")
	}
	if u.Scheme == "https" && strings.EqualFold(u.Hostname(), "api.openai.com") {
		return os.Getenv("OPENAI_API_KEY")
	}
	return ""
}

// agentModelsURL turns a Messages endpoint (…/v1/messages) or a Chat
// Completions endpoint (…/chat/completions) into the model list beside it
// (…/v1/models, or …/models for OpenRouter's /api/v1/chat/completions).
// Anthropic, OpenAI-compatible servers, LiteLLM and Ollama all serve that
// route.
func agentModelsURL(u *url.URL) *url.URL {
	out := *u
	if strings.HasSuffix(u.Path, "/v1/messages") {
		out.Path = strings.TrimSuffix(u.Path, "/v1/messages") + "/v1/models"
	} else {
		out.Path = strings.TrimSuffix(u.Path, "/chat/completions") + "/models"
	}
	out.RawQuery, out.Fragment = "", ""
	return &out
}

// agentModelsList is the shared shape of an Anthropic and an OpenAI model
// list: data[].id. Anthropic adds display_name, type "model" and
// has_more/last_id paging; OpenAI adds object "model" and owned_by.
type agentModelsList struct {
	Data []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Type        string `json:"type"`
	} `json:"data"`
	HasMore bool   `json:"has_more"`
	LastID  string `json:"last_id"`
	// Ollama's native /api/tags.
	Models []struct {
		Name string `json:"name"`
	} `json:"models"`
}

type agentModelsHTTPError struct{ status int }

func (e agentModelsHTTPError) Error() string {
	switch e.status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Sprintf("the endpoint rejected the API key (HTTP %d)", e.status)
	case http.StatusNotFound:
		return "the endpoint has no model list (HTTP 404); type the model name"
	}
	return fmt.Sprintf("the endpoint answered HTTP %d", e.status)
}

func getAgentModelsPage(ctx context.Context, client *http.Client, target *url.URL, key string) (agentModelsList, error) {
	var out agentModelsList
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	if key != "" {
		// Anthropic reads x-api-key; OpenAI-compatible servers and
		// LiteLLM read the bearer token. Both carry the same key to the
		// same host.
		req.Header.Set("x-api-key", key)
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := client.Do(req)
	if err != nil {
		// url.Error repeats the method and URL; the host is enough.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return out, fmt.Errorf("cannot reach %s: %v", target.Host, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, agentModelsHTTPError{resp.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, agentModelsMaxBody+1))
	if err != nil {
		return out, err
	}
	if len(data) > agentModelsMaxBody {
		return out, errors.New("model list too large")
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, errors.New("the endpoint did not return a JSON model list")
	}
	return out, nil
}

// listAgentModels fetches the model list for a Messages endpoint. Redirects
// are refused, so the key is never forwarded to another host.
func listAgentModels(ctx context.Context, endpoint *url.URL, key string) ([]agentModel, string, error) {
	ctx, cancel := context.WithTimeout(ctx, agentModelsTimeout)
	defer cancel()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	target := agentModelsURL(endpoint)
	models := []agentModel{}
	seen := map[string]bool{}
	style := ""
	for page := 0; page < agentModelsMaxPages; page++ {
		list, err := getAgentModelsPage(ctx, client, target, key)
		if err != nil {
			var httpErr agentModelsHTTPError
			// Older Ollama builds have no /v1/models; their native list
			// is /api/tags on the same local server.
			if page == 0 && errors.As(err, &httpErr) && httpErr.status == http.StatusNotFound && isLoopbackEndpoint(endpoint) {
				tags := &url.URL{Scheme: endpoint.Scheme, Host: endpoint.Host, Path: "/api/tags"}
				if list, err = getAgentModelsPage(ctx, client, tags, key); err == nil {
					for _, m := range list.Models {
						if m.Name != "" && !seen[m.Name] && len(models) < agentModelsMax {
							seen[m.Name] = true
							models = append(models, agentModel{ID: m.Name})
						}
					}
					sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
					return models, "ollama", nil
				}
			}
			return nil, "", err
		}
		for _, m := range list.Data {
			if m.ID == "" || seen[m.ID] || len(models) >= agentModelsMax {
				continue
			}
			seen[m.ID] = true
			models = append(models, agentModel{ID: m.ID, Name: m.DisplayName})
			if style == "" {
				if m.Type == "model" || m.DisplayName != "" {
					style = "anthropic"
				} else {
					style = "openai"
				}
			}
		}
		if !list.HasMore || list.LastID == "" || len(models) >= agentModelsMax {
			break
		}
		next := *target
		q := url.Values{"limit": {"1000"}, "after_id": {list.LastID}}
		next.RawQuery = q.Encode()
		target = &next
	}
	if style == "" {
		style = "openai"
	}
	// Anthropic lists newest first, which is the useful order; OpenAI
	// order is arbitrary, so sort it.
	if style == "openai" {
		sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	}
	return models, style, nil
}

func isLoopbackEndpoint(u *url.URL) bool {
	switch strings.ToLower(u.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// HandleAgentModels lists the models an endpoint offers, for the model
// picker in Settings > Agent. The page may send an endpoint and key it has
// not saved yet; see agentModelsKey for which stored key is used otherwise.
func (h *Services) HandleAgentModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req agentEndpointRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeAgentError(w, http.StatusBadRequest, "invalid models request", nil)
		return
	}
	cfg, saved, err := h.agentRequestConfig(req)
	if err != nil {
		writeAgentError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	endpoint, _ := url.Parse(cfg.URL)
	models, style, err := listAgentModels(r.Context(), endpoint, agentModelsKey(endpoint, strings.TrimSpace(req.APIKey), saved))
	if err != nil {
		writeAgentError(w, http.StatusBadGateway, "Could not list models: "+err.Error(), nil)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"models": models, "style": style, "url": agentModelsURL(endpoint).String()})
}
