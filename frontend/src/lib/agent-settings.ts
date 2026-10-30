import { API_BASE_URL } from '@/lib/api-client';

export type AgentSettingSource = 'env' | 'saved' | 'default';

export type AgentSettingValue = {
  value: string;
  source: AgentSettingSource;
  saved: string;
  default: string;
};

/** The two request formats the agent speaks. */
export type AgentProvider = 'anthropic' | 'openai';

export const AGENT_PROVIDERS: {
  id: AgentProvider;
  name: string;
  suffix: string;
  examples: { label: string; url: string }[];
}[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    suffix: '/v1/messages',
    examples: [
      { label: 'Claude API', url: 'https://api.anthropic.com/v1/messages' },
      { label: 'Local proxy', url: 'http://127.0.0.1:8789/v1/messages' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI compatible',
    suffix: '/chat/completions',
    examples: [
      { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions' },
      { label: 'Ollama', url: 'http://localhost:11434/v1/chat/completions' },
      { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
    ],
  },
];

export const providerInfo = (p: AgentProvider) =>
  AGENT_PROVIDERS.find((x) => x.id === p) ?? AGENT_PROVIDERS[0];

export type AgentSettings = {
  path: string;
  provider: { value: AgentProvider; source: AgentSettingSource; saved: string; default: string };
  proxy_url: AgentSettingValue;
  model: AgentSettingValue;
  api_key: {
    source: 'env' | 'saved' | 'anthropic_env' | 'openai_env' | 'none';
    saved: boolean;
    saved_hint?: string;
    saved_host?: string;
    /** The saved key itself, sent only to LogSonic's own page (same origin). */
    saved_value?: string;
    /** False when this page is on another origin (the split dev setup). */
    revealable?: boolean;
  };
  anthropic_api_key_env: boolean;
  openai_api_key_env?: boolean;
  mcp_config: string;
  mcp_config_in_storage: boolean;
  error?: string;
};

/** Fields left out keep their saved value; '' resets a field to its default. */
export type AgentSettingsUpdate = {
  provider?: AgentProvider;
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
  request: { provider: AgentProvider; proxy_url: string; api_key?: string },
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

export type AgentTestResult = {
  ok: true;
  provider: AgentProvider;
  model: string;
  host: string;
  latency_ms: number;
  reply: string;
  stop_reason: string;
};

/**
 * Sends one short request with the fields as typed (saved or not), so the
 * user can check the format, endpoint, model and key before saving.
 */
export async function testAgentEndpoint(
  request: { provider: AgentProvider; proxy_url: string; model: string; api_key?: string },
  signal?: AbortSignal
): Promise<AgentTestResult> {
  return readJSON(
    await fetch(`${API_BASE_URL}/agent/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  );
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Mirrors the server's endpoint rule, so the page only asks for valid URLs. */
export function validAgentEndpoint(raw: string, provider: AgentProvider = 'anthropic'): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  const suffix = providerInfo(provider).suffix;
  if (!u.hostname || u.username || u.password || !u.pathname.endsWith(suffix)) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK.includes(u.hostname.toLowerCase());
}

/**
 * Why an endpoint is not valid yet, and the URL it most likely should be,
 * for the hint under the field. Returns null when the endpoint is valid or
 * empty.
 */
export function endpointAdvice(
  raw: string,
  provider: AgentProvider
): { problem: string; suggestion?: string } | null {
  const value = raw.trim();
  if (!value || validAgentEndpoint(value, provider)) return null;
  const { suffix } = providerInfo(provider);
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { problem: `Enter a full URL ending in ${suffix}.` };
  }
  if (u.username || u.password)
    return { problem: 'Remove the user name and password from the URL.' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { problem: 'Use an http:// or https:// URL.' };
  const loopback = LOOPBACK.includes(u.hostname.toLowerCase());
  if (u.protocol === 'http:' && !loopback) u.protocol = 'https:';
  let path = u.pathname.replace(/\/+$/, '');
  const other = provider === 'openai' ? '/v1/messages' : '/v1/chat/completions';
  if (path.endsWith(other))
    path =
      path.slice(0, -other.length) +
      (provider === 'openai' ? '/v1/chat/completions' : '/v1/messages');
  else if (path.endsWith('/chat/completions') && provider === 'anthropic')
    path = path.slice(0, -'/chat/completions'.length) + '/messages';
  else if (path.endsWith('/v1') || path.endsWith('/api/v1'))
    path += provider === 'openai' ? '/chat/completions' : '/messages';
  else if (!path.endsWith(suffix))
    path += provider === 'openai' ? '/v1/chat/completions' : '/v1/messages';
  u.pathname = path;
  u.search = '';
  u.hash = '';
  const suggestion = u.toString();
  const problem =
    raw.trim().startsWith('http://') && !loopback
      ? 'Plain http:// is allowed only on localhost; use https:// for a remote server.'
      : `The URL must end in ${suffix}.`;
  return validAgentEndpoint(suggestion, provider) && suggestion !== value
    ? { problem, suggestion }
    : { problem };
}

/**
 * The same endpoint in the other format: …/v1/messages ↔ …/v1/chat/completions
 * on the same host, so a saved key stays bound to it. Returns null when the
 * endpoint does not end in the other format's path.
 */
export function swapEndpointFormat(raw: string, to: AgentProvider): string | null {
  const value = raw.trim();
  if (to === 'openai' && value.endsWith('/v1/messages'))
    return value.slice(0, -'/v1/messages'.length) + '/v1/chat/completions';
  if (to === 'anthropic' && value.endsWith('/v1/chat/completions'))
    return value.slice(0, -'/v1/chat/completions'.length) + '/v1/messages';
  return null;
}

// The command runs where the server stores mcp.json, so the path's shape picks
// the shell, not the browser: a Linux container viewed from a Mac needs nano.
export type PathOS = 'windows' | 'mac' | 'unix';
export const pathOS = (path: string): PathOS =>
  /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    ? 'windows'
    : /^\/Users\/[^/]+\/Library\//.test(path)
      ? 'mac'
      : 'unix';

const shellQuote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
const psQuote = (path: string) => `'${path.replace(/'/g, "''")}'`;

export const editCommand = (path: string) => {
  const dirPath = path.replace(/[/\\][^/\\]*$/, '');
  switch (pathOS(path)) {
    case 'windows':
      return `New-Item -ItemType Directory -Force -Path ${psQuote(dirPath)} | Out-Null; if (!(Test-Path ${psQuote(path)})) { New-Item -ItemType File -Path ${psQuote(path)} | Out-Null }; notepad ${psQuote(path)}`;
    case 'mac':
      return `mkdir -p ${shellQuote(dirPath || '/')} && touch ${shellQuote(path)} && open -t ${shellQuote(path)}`;
    default:
      return `mkdir -p ${shellQuote(dirPath || '/')} && \${EDITOR:-nano} ${shellQuote(path)}`;
  }
};
