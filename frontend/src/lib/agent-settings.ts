import { API_BASE_URL } from '@/lib/api-client';

export type AgentSettingSource = 'env' | 'saved' | 'default';

export type AgentSettingValue = {
  value: string;
  source: AgentSettingSource;
  saved: string;
  default: string;
};

export type AgentSettings = {
  path: string;
  proxy_url: AgentSettingValue;
  model: AgentSettingValue;
  api_key: {
    source: 'env' | 'saved' | 'anthropic_env' | 'none';
    saved: boolean;
    saved_hint?: string;
    saved_host?: string;
  };
  anthropic_api_key_env: boolean;
  mcp_config: string;
  mcp_config_in_storage: boolean;
  error?: string;
};

/** Fields left out keep their saved value; '' resets a field to its default. */
export type AgentSettingsUpdate = {
  proxy_url?: string;
  model?: string;
  api_key?: string;
  clear_api_key?: boolean;
};

export type AgentMCPServer = {
  name: string;
  transport: string;
  target: string;
  disabled?: boolean;
  connected: boolean;
  tools: string[];
  error?: string;
};

export type AgentMCPStatus = {
  config: string;
  config_error?: string;
  skipped?: string[];
  servers: AgentMCPServer[];
  connected: number;
  tool_count: number;
  config_exists: boolean;
};

async function readJSON<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || `Server returned ${response.status}.`);
  return data as T;
}

export async function fetchAgentSettings(): Promise<AgentSettings> {
  return readJSON(await fetch(`${API_BASE_URL}/agent/settings`));
}

export async function saveAgentSettings(update: AgentSettingsUpdate): Promise<AgentSettings> {
  return readJSON(
    await fetch(`${API_BASE_URL}/agent/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    })
  );
}

/** Connects the servers listed in mcp.json and reports each one. */
export async function fetchAgentMCP(): Promise<AgentMCPStatus> {
  return readJSON(await fetch(`${API_BASE_URL}/agent/mcp`));
}

/** host[:port] of an endpoint URL, matching the Go side's url.Host. */
export function endpointHost(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return '';
  }
}

export type AgentModelOption = { id: string; name?: string };

export type AgentModelList = {
  models: AgentModelOption[];
  /** Response shape the endpoint used. */
  style: 'anthropic' | 'openai' | 'ollama';
  url: string;
};

/**
 * Lists the models an endpoint offers (Anthropic or OpenAI-style
 * /v1/models, or Ollama's /api/tags). The server makes the call, so a key
 * typed here but not saved yet can be used; without one, the server uses a
 * stored key only for the host it belongs to.
 */
export async function fetchAgentModels(
  request: { proxy_url: string; api_key?: string },
  signal?: AbortSignal
): Promise<AgentModelList> {
  return readJSON(
    await fetch(`${API_BASE_URL}/agent/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  );
}

/** Mirrors the server's endpoint rule, so the page only asks for valid URLs. */
export function validAgentEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (!u.hostname || u.username || u.password || !u.pathname.endsWith('/v1/messages')) return false;
  if (u.protocol === 'https:') return true;
  return (
    u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())
  );
}
