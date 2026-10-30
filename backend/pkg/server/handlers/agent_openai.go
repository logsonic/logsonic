package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// The agent loop keeps its conversation in Anthropic Messages shape (text,
// tool_use and tool_result blocks). For an OpenAI-compatible endpoint this
// file converts that history to Chat Completions messages on the way out and
// converts each reply back to Anthropic blocks, so runAgentLoop replays the
// conversation the same way for both formats.

// agentBlock is any content block the loop stores: model output (text,
// tool_use, thinking) and the tool results it sends back.
type agentBlock struct {
	Type      string         `json:"type"`
	Text      string         `json:"text,omitempty"`
	ID        string         `json:"id,omitempty"`
	Name      string         `json:"name,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	ToolUseID string         `json:"tool_use_id,omitempty"`
	Content   any            `json:"content,omitempty"`
}

type openAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// openAIMessages converts the system prompt and the loop's history to Chat
// Completions messages. Each tool_result becomes its own "tool" message;
// thinking blocks have no counterpart and are dropped.
func openAIMessages(system string, messages []agentMessage) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages)+1)
	if system != "" {
		out = append(out, map[string]any{"role": "system", "content": system})
	}
	for _, m := range messages {
		if text, ok := m.Content.(string); ok {
			out = append(out, map[string]any{"role": m.Role, "content": text})
			continue
		}
		raw, err := json.Marshal(m.Content)
		if err != nil {
			return nil, err
		}
		var blocks []agentBlock
		if err := json.Unmarshal(raw, &blocks); err != nil {
			return nil, fmt.Errorf("unexpected %s message content: %w", m.Role, err)
		}
		var texts []string
		var calls []map[string]any
		for _, b := range blocks {
			switch b.Type {
			case "text":
				texts = append(texts, b.Text)
			case "tool_use":
				args, _ := json.Marshal(b.Input)
				if b.Input == nil {
					args = []byte("{}")
				}
				calls = append(calls, map[string]any{"id": b.ID, "type": "function", "function": map[string]any{"name": b.Name, "arguments": string(args)}})
			case "tool_result":
				content, ok := b.Content.(string)
				if !ok {
					encoded, _ := json.Marshal(b.Content)
					content = string(encoded)
				}
				out = append(out, map[string]any{"role": "tool", "tool_call_id": b.ToolUseID, "content": content})
			}
		}
		if m.Role == "assistant" {
			msg := map[string]any{"role": "assistant", "content": strings.Join(texts, "\n")}
			if len(calls) > 0 {
				msg["tool_calls"] = calls
				if len(texts) == 0 {
					msg["content"] = nil
				}
			}
			out = append(out, msg)
		} else if len(texts) > 0 {
			out = append(out, map[string]any{"role": m.Role, "content": strings.Join(texts, "\n")})
		}
	}
	return out, nil
}

// openAITools converts Anthropic tool schemas (name, description,
// input_schema) to Chat Completions function tools.
func openAITools(tools []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		fn := map[string]any{"name": t["name"]}
		if d, ok := t["description"]; ok {
			fn["description"] = d
		}
		if s, ok := t["input_schema"]; ok && s != nil {
			fn["parameters"] = s
		} else {
			fn["parameters"] = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{"type": "function", "function": fn})
	}
	return out
}

func openAIProxyRequest(ctx context.Context, cfg agentConfig, messages []agentMessage, tools []map[string]any, stream bool) (*http.Request, error) {
	return openAIRequest(ctx, cfg, agentSystemPrompt, agentMaxTokens, messages, tools, stream)
}

func openAIRequest(ctx context.Context, cfg agentConfig, system string, maxTokens int, messages []agentMessage, tools []map[string]any, stream bool) (*http.Request, error) {
	converted, err := openAIMessages(system, messages)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{"model": cfg.Model, "messages": converted}
	// OpenAI's own API takes max_completion_tokens (its reasoning models
	// reject max_tokens); Ollama, vLLM, LiteLLM and most gateways read
	// max_tokens.
	if u, err := url.Parse(cfg.URL); err == nil && strings.EqualFold(u.Hostname(), "api.openai.com") {
		payload["max_completion_tokens"] = maxTokens
	} else {
		payload["max_tokens"] = maxTokens
	}
	if len(tools) > 0 {
		payload["tools"] = openAITools(tools)
	}
	if stream {
		payload["stream"] = true
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Key)
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	return req, nil
}

// openAIStopReason maps a Chat Completions finish_reason to the Anthropic
// stop_reason the loop checks.
func openAIStopReason(finish string, hasTools bool) string {
	if hasTools {
		return "tool_use"
	}
	switch finish {
	case "stop", "":
		return "end_turn"
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	}
	return finish
}

// openAIBlocks builds the Anthropic-shape content for one reply: the text
// first, then one tool_use block per call. Calls without an id (some local
// servers omit it) get a generated one, since tool results refer to it.
func openAIBlocks(text string, calls []openAIToolCall) ([]json.RawMessage, error) {
	var out []json.RawMessage
	if text != "" {
		encoded, _ := json.Marshal(map[string]any{"type": "text", "text": text})
		out = append(out, encoded)
	}
	for i, call := range calls {
		if call.Function.Name == "" {
			return nil, errors.New("proxy returned malformed tool call")
		}
		input := map[string]any{}
		if raw := strings.TrimSpace(call.Function.Arguments); raw != "" {
			if err := json.Unmarshal([]byte(raw), &input); err != nil {
				return nil, errors.New("proxy returned malformed tool input")
			}
		}
		id := call.ID
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		encoded, _ := json.Marshal(map[string]any{"type": "tool_use", "id": id, "name": call.Function.Name, "input": input})
		out = append(out, encoded)
	}
	return out, nil
}

func openAIErrorText(raw json.RawMessage) string {
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Message != "" {
		return e.Message
	}
	return strings.TrimSpace(string(raw))
}

func parseOpenAIReply(data []byte) (proxyReply, error) {
	var out proxyReply
	var resp struct {
		Choices []struct {
			Message struct {
				Content   *string          `json:"content"`
				ToolCalls []openAIToolCall `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return out, fmt.Errorf("invalid proxy response: %w", err)
	}
	if len(resp.Choices) == 0 {
		if len(resp.Error) > 0 && string(resp.Error) != "null" {
			return out, fmt.Errorf("proxy error: %s", openAIErrorText(resp.Error))
		}
		return out, errors.New("proxy returned no choices")
	}
	choice := resp.Choices[0]
	text := ""
	if choice.Message.Content != nil {
		text = *choice.Message.Content
	}
	blocks, err := openAIBlocks(text, choice.Message.ToolCalls)
	if err != nil {
		return out, err
	}
	out.Content = blocks
	out.StopReason = openAIStopReason(choice.FinishReason, len(choice.Message.ToolCalls) > 0)
	return out, nil
}

// readOpenAIStream reads a Chat Completions stream, forwards text deltas to
// onText and reassembles the reply. Tool call fragments arrive keyed by
// index: the first carries the id and name, later ones append arguments.
func readOpenAIStream(body io.Reader, onText func(string)) (proxyReply, error) {
	var out proxyReply
	var text strings.Builder
	calls := map[int]*openAIToolCall{}
	finish := ""
	done := false
	total := 0
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line)
		if total > 4*1024*1024 {
			return out, errors.New("proxy response too large")
		}
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			done = true
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   *string `json:"content"`
					ToolCalls []struct {
						Index    *int   `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Error json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return out, fmt.Errorf("invalid proxy stream event: %w", err)
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return out, fmt.Errorf("proxy stream error: %s", openAIErrorText(chunk.Error))
		}
		for _, choice := range chunk.Choices {
			if c := choice.Delta.Content; c != nil && *c != "" {
				text.WriteString(*c)
				onText(*c)
			}
			for _, tc := range choice.Delta.ToolCalls {
				index := len(calls)
				if tc.Index != nil {
					index = *tc.Index
				}
				call := calls[index]
				// A new id at a used index is a separate call from a
				// server that does not number its calls.
				if call != nil && tc.ID != "" && call.ID != "" && tc.ID != call.ID {
					index = len(calls)
					call = nil
				}
				if call == nil {
					call = &openAIToolCall{Type: "function"}
					calls[index] = call
				}
				if tc.ID != "" {
					call.ID = tc.ID
				}
				call.Function.Name += tc.Function.Name
				call.Function.Arguments += tc.Function.Arguments
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finish = *choice.FinishReason
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return out, err
	}
	if !done && finish == "" {
		return out, errors.New("proxy stream ended before the message completed")
	}
	indexes := make([]int, 0, len(calls))
	for i := range calls {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	ordered := make([]openAIToolCall, 0, len(calls))
	for _, i := range indexes {
		ordered = append(ordered, *calls[i])
	}
	blocks, err := openAIBlocks(text.String(), ordered)
	if err != nil {
		return out, err
	}
	out.Content = blocks
	out.StopReason = openAIStopReason(finish, len(ordered) > 0)
	return out, nil
}
