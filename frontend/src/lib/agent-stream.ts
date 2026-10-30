import { API_BASE_URL } from '@/lib/api-client';

/**
 * Client for POST /agent/chat. With stream:true the server answers with
 * text/event-stream events (text, step_start, step, done, error); EventSource
 * cannot POST, so the body is read and split into events here. A server that
 * answers with plain JSON (older backend) is handled as a single done event.
 */

export type AgentWireStep = {
  id?: string;
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
  is_error?: boolean;
};

export type AgentStreamEvent =
  | { type: 'text'; round: number; delta: string }
  | { type: 'step_start'; id: string; tool: string; input: Record<string, unknown> }
  | { type: 'step'; step: AgentWireStep }
  | { type: 'done'; answer: string; steps: AgentWireStep[] }
  | { type: 'error'; error: string; steps: AgentWireStep[] };

export type AgentMessage = { role: 'user' | 'assistant'; content: string };

/** External MCP servers the agent can use; counts are 0 until the first chat connects them. */
export type AgentMCPSummary = { config: string; servers: number; connected: number; tools: number };

export type AgentStatus = {
  available: boolean;
  provider?: 'anthropic' | 'openai';
  model?: string;
  proxy_url?: string;
  reason?: string;
  error?: string;
  mcp?: AgentMCPSummary;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asSteps = (value: unknown): AgentWireStep[] => (Array.isArray(value) ? value : []);

export const parseAgentEvent = (name: string, raw: string): AgentStreamEvent | null => {
  let data: Record<string, unknown>;
  try {
    data = asObject(JSON.parse(raw));
  } catch {
    return null;
  }
  switch (name) {
    case 'text':
      return { type: 'text', round: Number(data.round) || 0, delta: String(data.delta ?? '') };
    case 'step_start':
      return {
        type: 'step_start',
        id: String(data.id ?? ''),
        tool: String(data.tool ?? ''),
        input: asObject(data.input),
      };
    case 'step':
      return { type: 'step', step: data as unknown as AgentWireStep };
    case 'done':
      return { type: 'done', answer: String(data.answer ?? ''), steps: asSteps(data.steps) };
    case 'error':
      return {
        type: 'error',
        error: String(data.error ?? 'The agent request failed.'),
        steps: asSteps(data.steps),
      };
    default:
      return null;
  }
};

/** Split an SSE buffer into complete events; returns the unconsumed tail. */
export const splitSSE = (buffer: string): { events: Array<[string, string]>; rest: string } => {
  const events: Array<[string, string]> = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push([name, data.join('\n')]);
  }
  return { events, rest };
};

export async function fetchAgentStatus(signal?: AbortSignal): Promise<AgentStatus> {
  const response = await fetch(`${API_BASE_URL}/agent/status`, { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || `Server returned ${response.status}.`);
  return data as AgentStatus;
}

export async function streamAgentChat(
  messages: AgentMessage[],
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/event-stream') || !response.body) {
    const data = asObject(await response.json().catch(() => null));
    const error = data.error || data.detail;
    if (!response.ok || error) {
      onEvent({
        type: 'error',
        error: typeof error === 'string' && error ? error : `Server returned ${response.status}.`,
        steps: asSteps(data.steps),
      });
    } else {
      onEvent({ type: 'done', answer: String(data.answer ?? ''), steps: asSteps(data.steps) });
    }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitSSE(buffer);
    buffer = rest;
    for (const [name, raw] of events) {
      const event = parseAgentEvent(name, raw);
      if (!event) continue;
      if (event.type === 'done' || event.type === 'error') finished = true;
      onEvent(event);
    }
  }
  if (!finished) {
    onEvent({
      type: 'error',
      error: 'The connection closed before the agent finished.',
      steps: [],
    });
  }
}
