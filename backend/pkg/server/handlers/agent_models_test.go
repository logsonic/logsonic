package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestAgentModelsListsAnthropicStyleAcrossPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/anthropic/v1/models" || r.Header.Get("x-api-key") != "sk-a" || r.Header.Get("anthropic-version") == "" {
			t.Errorf("request %s key=%q", r.URL, r.Header.Get("x-api-key"))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("after_id") == "" {
			w.Write([]byte(`{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5"},{"type":"model","id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5"}],"has_more":true,"last_id":"claude-sonnet-5-5"}`))
			return
		}
		if r.URL.Query().Get("after_id") != "claude-sonnet-5-5" {
			t.Errorf("after_id = %q", r.URL.Query().Get("after_id"))
		}
		w.Write([]byte(`{"data":[{"type":"model","id":"claude-haiku-5-5","display_name":"Claude Haiku 5.5"}],"has_more":false}`))
	}))
	defer srv.Close()
	models, style, err := listAgentModels(context.Background(), mustURL(t, srv.URL+"/anthropic/v1/messages"), "sk-a")
	if err != nil {
		t.Fatal(err)
	}
	if style != "anthropic" || len(models) != 3 || models[0].ID != "claude-opus-5-5" || models[0].Name != "Claude Opus 5.5" || models[2].ID != "claude-haiku-5-5" {
		t.Fatalf("style %s models %+v", style, models)
	}
}

func TestAgentModelsListsOpenAIStyleSorted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-o" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"object":"list","data":[{"id":"gpt-5","object":"model","owned_by":"openai"},{"id":"bedrock-claude","object":"model","owned_by":"litellm"},{"id":"gpt-5","object":"model"}]}`))
	}))
	defer srv.Close()
	models, style, err := listAgentModels(context.Background(), mustURL(t, srv.URL+"/v1/messages"), "sk-o")
	if err != nil {
		t.Fatal(err)
	}
	if style != "openai" || len(models) != 2 || models[0].ID != "bedrock-claude" || models[1].ID != "gpt-5" {
		t.Fatalf("style %s models %+v", style, models)
	}
}

func TestAgentModelsFallsBackToOllamaTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			w.Write([]byte(`{"models":[{"name":"qwen3-coder:latest"},{"name":"llama4:8b"}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	models, style, err := listAgentModels(context.Background(), mustURL(t, srv.URL+"/v1/messages"), "")
	if err != nil {
		t.Fatal(err)
	}
	if style != "ollama" || len(models) != 2 || models[0].ID != "llama4:8b" {
		t.Fatalf("style %s models %+v", style, models)
	}
}

func TestAgentModelsRefusesRedirectsAndReportsAuthErrors(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Store(true)
		w.Write([]byte(`{"data":[{"id":"x"}]}`))
	}))
	defer other.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/v1/models", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	if _, _, err := listAgentModels(context.Background(), mustURL(t, redirect.URL+"/v1/messages"), "sk-secret"); err == nil {
		t.Error("redirect was followed")
	}
	if leaked.Load() {
		t.Error("the key reached the redirect target")
	}

	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer denied.Close()
	if _, _, err := listAgentModels(context.Background(), mustURL(t, denied.URL+"/v1/messages"), "bad"); err == nil || !strings.Contains(err.Error(), "rejected the API key") {
		t.Errorf("err = %v", err)
	}
}

// The page can name any endpoint, so a stored key may only go where the
// agent itself would send it.
func TestAgentModelsKeyNeverFollowsAnArbitraryURL(t *testing.T) {
	clearAgentEnv(t)
	evil := mustURL(t, "https://evil.example.com/v1/messages")
	claude := mustURL(t, "https://api.anthropic.com/v1/messages")
	gateway := mustURL(t, "https://gateway.example.com/v1/messages")
	saved := agentSavedSettings{ProxyURL: gateway.String(), APIKey: "sk-saved", APIKeyHost: "gateway.example.com"}

	if got := agentModelsKey(evil, "typed", saved); got != "typed" {
		t.Errorf("typed key: %q", got)
	}
	if got := agentModelsKey(evil, "", saved); got != "" {
		t.Errorf("saved key sent to another host: %q", got)
	}
	if got := agentModelsKey(gateway, "", saved); got != "sk-saved" {
		t.Errorf("saved key not sent to its host: %q", got)
	}

	t.Setenv("ANTHROPIC_API_KEY", "sk-ant")
	if got := agentModelsKey(evil, "", saved); got != "" {
		t.Errorf("ANTHROPIC_API_KEY sent to another host: %q", got)
	}
	if got := agentModelsKey(claude, "", saved); got != "sk-ant" {
		t.Errorf("ANTHROPIC_API_KEY not sent to the Claude API: %q", got)
	}

	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "sk-env")
	if got := agentModelsKey(evil, "", saved); got != "" {
		t.Errorf("LOGSONIC_AGENT_PROXY_KEY sent to another host: %q", got)
	}
	if got := agentModelsKey(gateway, "", saved); got != "sk-env" {
		t.Errorf("LOGSONIC_AGENT_PROXY_KEY not sent to the configured host: %q", got)
	}
}

func TestHandleAgentModelsUsesTypedEndpointAndKey(t *testing.T) {
	clearAgentEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "sk-typed" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"data":[{"id":"m1","object":"model"}]}`))
	}))
	defer srv.Close()
	h := &Services{StoragePath: t.TempDir()}
	post := func(body string) (int, map[string]any) {
		w := httptest.NewRecorder()
		h.HandleAgentModels(w, httptest.NewRequest(http.MethodPost, "/api/v1/agent/models", bytes.NewBufferString(body)))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, out := post(`{"proxy_url":"` + srv.URL + `/v1/messages","api_key":"sk-typed"}`)
	if code != http.StatusOK || out["style"] != "openai" || len(out["models"].([]any)) != 1 {
		t.Fatalf("%d %v", code, out)
	}
	if code, out := post(`{"proxy_url":"` + srv.URL + `/v1/messages"}`); code != http.StatusBadGateway || !strings.Contains(out["error"].(string), "rejected the API key") {
		t.Fatalf("%d %v", code, out)
	}
	for _, body := range []string{`{"proxy_url":"http://gateway.example.com/v1/messages"}`, `{"proxy_url":"` + srv.URL + `/v1/complete"}`, `{"api_key":"a b"}`, `{"other":1}`} {
		if code, _ := post(body); code != http.StatusBadRequest {
			t.Errorf("%s: %d", body, code)
		}
	}
}
