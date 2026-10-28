package handlers

import "testing"

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
		t.Setenv("LOGSONIC_AGENT_PROXY_URL", url)
		if _, err := agentProxyEndpoint(); (err == nil) != ok {
			t.Errorf("%s: err=%v, want ok=%v", url, err, ok)
		}
	}
}

func TestAgentProxyKeyFallsBackToAnthropicKeyOnlyForClaudeAPI(t *testing.T) {
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "http://127.0.0.1:8789/v1/messages")
	if got := agentProxyKey(); got != "local-proxy" {
		t.Errorf("local proxy got %q; the Anthropic key must not go to a local proxy by default", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://llm-gateway.example.com/anthropic/v1/messages")
	if got := agentProxyKey(); got != "local-proxy" {
		t.Errorf("a third-party gateway got %q; the Anthropic key must only go to api.anthropic.com", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://api.anthropic.com/v1/messages")
	if got := agentProxyKey(); got != "sk-test" {
		t.Errorf("Claude API endpoint got %q", got)
	}
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "explicit")
	if got := agentProxyKey(); got != "explicit" {
		t.Errorf("explicit key got %q", got)
	}
}
