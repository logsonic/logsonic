import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentSettings from '../AgentSettings';

import type { AgentMCPStatus, AgentSettings as AgentSettingsData } from '@/lib/agent-settings';

const api = vi.hoisted(() => ({
  fetchAgentSettings: vi.fn(),
  saveAgentSettings: vi.fn(),
  fetchAgentMCP: vi.fn(),
  fetchAgentModels: vi.fn(),
}));
const stream = vi.hoisted(() => ({ fetchAgentStatus: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/agent-settings', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/agent-settings')>('@/lib/agent-settings');
  return { ...actual, ...api };
});
vi.mock('@/lib/agent-stream', () => stream);
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/native', () => ({ isNativeShell: () => false, revealStoragePath: () => false }));

const settings = (over: Partial<AgentSettingsData> = {}): AgentSettingsData => ({
  path: '/data/logsonic/agent.json',
  proxy_url: {
    value: 'https://api.anthropic.com/v1/messages',
    source: 'saved',
    saved: 'https://api.anthropic.com/v1/messages',
    default: 'http://127.0.0.1:8789/v1/messages',
  },
  model: { value: 'claude-sonnet-5-5', source: 'default', saved: '', default: 'claude-sonnet-5-5' },
  api_key: {
    source: 'saved',
    saved: true,
    saved_hint: '••••1234',
    saved_host: 'api.anthropic.com',
  },
  anthropic_api_key_env: false,
  mcp_config: '/data/logsonic/mcp.json',
  mcp_config_in_storage: true,
  ...over,
});

const mcp = (over: Partial<AgentMCPStatus> = {}): AgentMCPStatus => ({
  config: '/data/logsonic/mcp.json',
  servers: [
    {
      name: 'notes',
      transport: 'stdio',
      target: 'npx',
      connected: true,
      tools: ['read_text_file'],
    },
    {
      name: 'tickets',
      transport: 'http',
      target: 'mcp.example.com',
      connected: false,
      tools: [],
      error: 'connection refused',
    },
  ],
  connected: 1,
  tool_count: 1,
  config_exists: true,
  ...over,
});

// cmdk (the model picker) needs these in jsdom.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const renderPage = () =>
  render(
    <MemoryRouter>
      <AgentSettings />
    </MemoryRouter>
  );

describe('AgentSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAgentSettings.mockResolvedValue(settings());
    api.fetchAgentMCP.mockResolvedValue(mcp());
    stream.fetchAgentStatus.mockResolvedValue({ available: true, model: 'claude-sonnet-5-5' });
    api.fetchAgentModels.mockResolvedValue({
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      ],
      style: 'anthropic',
      url: 'https://api.anthropic.com/v1/models',
    });
  });

  it('shows the effective settings, MCP file instructions and server status', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('https://api.anthropic.com/v1/messages')).toBeTruthy();
    expect(screen.getByDisplayValue('claude-sonnet-5-5')).toBeTruthy();
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('••••1234');
    expect(await screen.findByText('Connected · claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getAllByText('/data/logsonic/mcp.json').length).toBeGreaterThan(0);
    expect(screen.getByText('Format reference').closest('a')?.getAttribute('href')).toContain(
      '#use-other-mcp-servers-from-the-agent'
    );
    expect(await screen.findByText('notes')).toBeTruthy();
    expect(screen.getByText('connection refused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add server/i })).toBeNull();
  });

  it('saves only the changed fields and the new key', async () => {
    api.saveAgentSettings.mockResolvedValue(
      settings({
        proxy_url: { ...settings().proxy_url, value: 'http://localhost:11434/v1/messages' },
        model: { ...settings().model, value: 'qwen3-coder', source: 'saved' },
      })
    );
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' qwen3-coder ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenCalledWith({
        proxy_url: 'http://localhost:11434/v1/messages',
        model: 'qwen3-coder',
      })
    );
    expect(stream.fetchAgentStatus).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenLastCalledWith({ api_key: 'sk-new' })
    );
  });

  it('warns when the saved key belongs to another endpoint', async () => {
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.change(screen.getByLabelText('Model endpoint'), {
      target: { value: 'https://gateway.example.com/v1/messages' },
    });
    expect(screen.getByText(/saved key belongs to api.anthropic.com/)).toBeTruthy();
  });

  it('locks fields set by environment variables', async () => {
    api.fetchAgentSettings.mockResolvedValue(
      settings({
        proxy_url: { ...settings().proxy_url, source: 'env' },
        api_key: { source: 'env', saved: false },
      })
    );
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    expect((screen.getByLabelText('Model endpoint') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('API key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Model') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/Set by LOGSONIC_AGENT_PROXY_URL/)).toBeTruthy();
    expect(screen.getByText(/Set by LOGSONIC_AGENT_PROXY_KEY/)).toBeTruthy();
  });

  it('removes the saved key', async () => {
    api.saveAgentSettings.mockResolvedValue(
      settings({ api_key: { source: 'none', saved: false } })
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove saved key' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenCalledWith({ clear_api_key: true })
    );
  });

  it('lists the endpoint models once the URL is valid, with a typed key', async () => {
    renderPage();
    expect(
      await screen.findByText(
        /3 models from api.anthropic.com \(Anthropic\)/,
        {},
        { timeout: 3000 }
      )
    ).toBeTruthy();
    expect(api.fetchAgentModels).toHaveBeenLastCalledWith(
      { proxy_url: 'https://api.anthropic.com/v1/messages' },
      expect.any(AbortSignal)
    );

    api.fetchAgentModels.mockClear();
    fireEvent.change(screen.getByLabelText('Model endpoint'), {
      target: { value: 'https://gateway.example.com/v1/mess' },
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(api.fetchAgentModels).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Fetch models' }) as HTMLButtonElement).disabled
    ).toBe(true);

    api.fetchAgentModels.mockResolvedValue({
      models: [{ id: 'gpt-5' }, { id: 'litellm-claude' }],
      style: 'openai',
      url: 'https://gateway.example.com/v1/models',
    });
    fireEvent.change(screen.getByLabelText('Model endpoint'), {
      target: { value: 'https://gateway.example.com/v1/messages' },
    });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-gw' } });
    expect(
      await screen.findByText(
        /2 models from gateway.example.com \(OpenAI-style\)/,
        {},
        { timeout: 3000 }
      )
    ).toBeTruthy();
    expect(api.fetchAgentModels).toHaveBeenCalledTimes(1);
    expect(api.fetchAgentModels).toHaveBeenLastCalledWith(
      { proxy_url: 'https://gateway.example.com/v1/messages', api_key: 'sk-gw' },
      expect.any(AbortSignal)
    );
    expect(screen.getByText(/claude-sonnet-5-5 is not in this endpoint's list/)).toBeTruthy();
  });

  it('fills an empty model from the fetch button and picks from the list', async () => {
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-opus-5-5')
    );
    fireEvent.click(await screen.findByText('claude-haiku-5-5'));
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-haiku-5-5');
  });

  it('shows why models could not be listed', async () => {
    api.fetchAgentModels.mockRejectedValue(
      new Error('Could not list models: the endpoint rejected the API key (HTTP 401)')
    );
    renderPage();
    expect(await screen.findByText(/rejected the API key/, {}, { timeout: 3000 })).toBeTruthy();
  });
});
