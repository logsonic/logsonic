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
  testAgentEndpoint: vi.fn(),
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
  provider: { value: 'anthropic', source: 'default', saved: '', default: 'anthropic' },
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
    saved_value: 'sk-ant-saved-1234',
    revealable: true,
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
    expect(screen.getByRole('radio', { name: 'Anthropic' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(screen.queryByRole('button', { name: 'Ollama' })).toBeNull();
    expect(await screen.findByText('Connected · claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getAllByText('/data/logsonic/mcp.json').length).toBeGreaterThan(0);
    expect(screen.getByText('Format reference').closest('a')?.getAttribute('href')).toContain(
      '#use-other-mcp-servers-from-the-agent'
    );
    expect(await screen.findByText('notes')).toBeTruthy();
    expect(screen.getByText('connection refused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add server/i })).toBeNull();
  });

  it('shows the saved key behind a toggle', async () => {
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('sk-ant-saved-1234');
    expect(key.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(key.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide API key' }));
    expect(key.type).toBe('password');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches format, keeps the host, and rebinds the shown key to a new host', async () => {
    api.saveAgentSettings.mockResolvedValue(settings());
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI compatible' }));
    expect(screen.getByDisplayValue('https://api.anthropic.com/v1/chat/completions')).toBeTruthy();
    // A Claude model name means nothing to an OpenAI-compatible server.
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/must end in/).textContent).toContain('/chat/completions');

    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'http://localhost:11434/v1/chat/completions' },
    });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' qwen3-coder ' } });
    expect(screen.getByText(/This key was saved for api.anthropic.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenCalledWith({
        provider: 'openai',
        proxy_url: 'http://localhost:11434/v1/chat/completions',
        model: 'qwen3-coder',
        api_key: 'sk-ant-saved-1234',
      })
    );
    expect(stream.fetchAgentStatus).toHaveBeenCalledTimes(2);
  });

  it('saves a new key, and clearing the field removes the saved one', async () => {
    api.saveAgentSettings.mockResolvedValue(settings());
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenLastCalledWith({ api_key: 'sk-new' })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear API key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenLastCalledWith({ clear_api_key: true })
    );
  });

  it('suggests the right path for an endpoint', async () => {
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI compatible' }));
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://api.openai.com/v1/' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Use https://api.openai.com/v1/chat/completions' })
    );
    expect(screen.getByDisplayValue('https://api.openai.com/v1/chat/completions')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Anthropic' }));
    expect(screen.getByDisplayValue('https://api.openai.com/v1/messages')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'http://gateway.example.com' },
    });
    expect(screen.getByText(/Plain http:\/\/ is allowed only on localhost/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Use https://gateway.example.com/v1/messages' })
    ).toBeTruthy();
  });

  it('tests the typed fields without saving', async () => {
    api.testAgentEndpoint.mockResolvedValue({
      ok: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      host: 'api.anthropic.com',
      latency_ms: 812,
      reply: 'OK',
      stop_reason: 'end_turn',
    });
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(
      await screen.findByText(/Works: claude-opus-5-5 at api.anthropic.com answered in 812 ms/)
    ).toBeTruthy();
    expect(api.testAgentEndpoint).toHaveBeenCalledWith(
      {
        provider: 'anthropic',
        proxy_url: 'https://api.anthropic.com/v1/messages',
        model: 'claude-opus-5-5',
        api_key: 'sk-ant-saved-1234',
      },
      expect.any(AbortSignal)
    );
    expect(api.saveAgentSettings).not.toHaveBeenCalled();

    api.testAgentEndpoint.mockRejectedValue(new Error('The endpoint rejected the API key.'));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-wrong' } });
    expect(screen.queryByTestId('agent-test-result')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('The endpoint rejected the API key.')).toBeTruthy();
  });

  it('falls back to the key hint when the page cannot see the key', async () => {
    api.fetchAgentSettings.mockResolvedValue(
      settings({
        api_key: {
          source: 'saved',
          saved: true,
          saved_hint: '••••1234',
          saved_host: 'api.anthropic.com',
          revealable: false,
        },
      })
    );
    api.saveAgentSettings.mockResolvedValue(
      settings({ api_key: { source: 'none', saved: false } })
    );
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('••••1234');
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://gateway.example.com/v1/messages' },
    });
    expect(screen.getByText(/saved key belongs to api.anthropic.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove saved key' }));
    await waitFor(() =>
      expect(api.saveAgentSettings).toHaveBeenCalledWith({ clear_api_key: true })
    );
  });

  it('locks fields set by environment variables', async () => {
    api.fetchAgentSettings.mockResolvedValue(
      settings({
        provider: { value: 'anthropic', source: 'env', saved: '', default: 'anthropic' },
        proxy_url: { ...settings().proxy_url, source: 'env' },
        api_key: { source: 'env', saved: false, revealable: true },
      })
    );
    renderPage();
    await screen.findByDisplayValue('https://api.anthropic.com/v1/messages');
    expect((screen.getByLabelText('Endpoint URL') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('API key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Model') as HTMLInputElement).disabled).toBe(false);
    expect(
      (screen.getByRole('radio', { name: 'OpenAI compatible' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/Set by LOGSONIC_AGENT_PROVIDER/)).toBeTruthy();
    expect(screen.getByText(/Set by LOGSONIC_AGENT_PROXY_URL/)).toBeTruthy();
    expect(screen.getByText(/Set by LOGSONIC_AGENT_PROXY_KEY/)).toBeTruthy();
  });

  it('lists the endpoint models once the URL is valid, never sending the shown key', async () => {
    renderPage();
    expect(
      await screen.findByText(
        /3 models from api.anthropic.com \(Anthropic\)/,
        {},
        { timeout: 3000 }
      )
    ).toBeTruthy();
    expect(api.fetchAgentModels).toHaveBeenLastCalledWith(
      { provider: 'anthropic', proxy_url: 'https://api.anthropic.com/v1/messages' },
      expect.any(AbortSignal)
    );

    api.fetchAgentModels.mockClear();
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://gateway.example.com/v1/mess' },
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(api.fetchAgentModels).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Fetch models' }) as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://api.anthropic.co/v1/messages' },
    });
    await waitFor(() => expect(api.fetchAgentModels).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.fetchAgentModels).toHaveBeenLastCalledWith(
      { provider: 'anthropic', proxy_url: 'https://api.anthropic.co/v1/messages' },
      expect.any(AbortSignal)
    );
    api.fetchAgentModels.mockClear();

    api.fetchAgentModels.mockResolvedValue({
      models: [{ id: 'gpt-5' }, { id: 'litellm-claude' }],
      style: 'openai',
      url: 'https://gateway.example.com/v1/models',
    });
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
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
      {
        provider: 'anthropic',
        proxy_url: 'https://gateway.example.com/v1/messages',
        api_key: 'sk-gw',
      },
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
