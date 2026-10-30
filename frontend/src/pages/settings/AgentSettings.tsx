import {
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { FC, useCallback, useEffect, useRef, useState } from 'react';

import { SettingsLayout } from './SettingsLayout';

import { CopyableValue } from '@/components/settings/CopyableValue';
import { CopyBlock } from '@/components/settings/CopyBlock';
import {
  settingsCard,
  settingsLabel,
  settingsNote,
  settingsRow,
} from '@/components/settings/styles';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/components/ui/use-toast';
import {
  AGENT_PROVIDERS,
  endpointAdvice,
  endpointHost,
  fetchAgentMCP,
  fetchAgentModels,
  fetchAgentSettings,
  providerInfo,
  saveAgentSettings,
  swapEndpointFormat,
  testAgentEndpoint,
  validAgentEndpoint,
  type AgentMCPStatus,
  type AgentModelList,
  type AgentProvider,
  type AgentSettings as AgentSettingsData,
  type AgentSettingsUpdate,
  type AgentTestResult,
} from '@/lib/agent-settings';
import { fetchAgentStatus, type AgentStatus } from '@/lib/agent-stream';
import { isNativeShell, revealStoragePath } from '@/lib/native';

const card = settingsCard;
const rowStyle = settingsRow;
const label = settingsLabel;
const note = settingsNote;

const MCP_DOCS_URL = 'https://github.com/logsonic/logsonic#use-other-mcp-servers-from-the-agent';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

const isLoopbackHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

const MCP_EXAMPLE = JSON.stringify(
  {
    mcpServers: {
      notes: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/runbooks'],
        tools: ['read_text_file', 'list_directory', 'search_files'],
      },
      tickets: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer <token>' },
      },
    },
  },
  null,
  2
);

const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

const shellQuote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

const editCommand = (path: string) => {
  const quoted = shellQuote(path);
  const dir = shellQuote(path.replace(/[/\\][^/\\]*$/, '') || '/');
  return isMac()
    ? `mkdir -p ${dir} && touch ${quoted} && open -t ${quoted}`
    : `mkdir -p ${dir} && \${EDITOR:-nano} ${quoted}`;
};

const STYLE_LABEL: Record<AgentModelList['style'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI-style',
  ollama: 'Ollama',
};

const envNote = (name: string) =>
  `Set by ${name} when the server started; unset it to change this here.`;

const keySourceLine = (s: AgentSettingsData, endpoint: string): string => {
  switch (s.api_key.source) {
    case 'env':
      return 'Using LOGSONIC_AGENT_PROXY_KEY from the environment.';
    case 'saved':
      return `Using the saved key ${s.api_key.saved_hint ?? ''}.`;
    case 'anthropic_env':
      return 'Using ANTHROPIC_API_KEY from the environment.';
    case 'openai_env':
      return 'Using OPENAI_API_KEY from the environment.';
    default:
      return endpointHost(endpoint) === 'api.anthropic.com'
        ? 'No key: the Claude API needs one.'
        : endpointHost(endpoint) === 'api.openai.com'
          ? 'No key: the OpenAI API needs one.'
          : 'No key. Local proxies, Ollama and LiteLLM without a master key do not need one.';
  }
};

/**
 * Settings > Agent: the API format (Anthropic or OpenAI compatible), endpoint,
 * model and API key (saved to <storage>/agent.json, readable only by the
 * user; the key is shown only on LogSonic's own page), and how to add MCP
 * servers. MCP servers are edited in mcp.json on disk on purpose: there is
 * no write API, so no web page or log line can make LogSonic start a program.
 */
const AgentSettings: FC = () => {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AgentSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider>('anthropic');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    result?: AgentTestResult;
    error?: string;
  } | null>(null);
  const [mcp, setMcp] = useState<AgentMCPStatus | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [models, setModels] = useState<AgentModelList | null>(null);
  const [modelsFor, setModelsFor] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelsRequest = useRef<AbortController | null>(null);
  const testRequest = useRef<AbortController | null>(null);

  const apply = (s: AgentSettingsData) => {
    setSettings(s);
    setProvider(s.provider?.value ?? 'anthropic');
    setEndpoint(s.proxy_url.value);
    setModel(s.model.value);
    setApiKey(s.api_key.revealable ? (s.api_key.saved_value ?? '') : '');
  };

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await fetchAgentStatus());
    } catch (err) {
      setStatus({ available: false, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  }, []);

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      setMcp(await fetchAgentMCP());
      setMcpError(null);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpLoading(false);
    }
  }, []);

  // Lists the endpoint's models. fill puts the first one in an empty Model
  // field (the refresh button); the automatic fetch only offers the list.
  const loadModels = useCallback(
    async (format: AgentProvider, url: string, key: string, fill: boolean) => {
      modelsRequest.current?.abort();
      const controller = new AbortController();
      modelsRequest.current = controller;
      setModelsLoading(true);
      setModelsError(null);
      try {
        const list = await fetchAgentModels(
          {
            provider: format,
            proxy_url: url.trim(),
            ...(key.trim() ? { api_key: key.trim() } : {}),
          },
          controller.signal
        );
        if (controller.signal.aborted) return;
        setModels(list);
        setModelsFor(url.trim());
        if (fill && list.models.length > 0) {
          setModel((current) => (current.trim() ? current : list.models[0].id));
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setModels(null);
        setModelsFor(url.trim());
        setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (modelsRequest.current === controller) setModelsLoading(false);
      }
    },
    []
  );

  const load = useCallback(async () => {
    try {
      apply(await fetchAgentSettings());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void check();
    void loadMcp();
  }, [load, check, loadMcp]);

  const loaded = settings !== null;
  const endpointValid = validAgentEndpoint(endpoint, provider);
  // The key sent with a model list request. The saved key shown in the field
  // is left out, so the server sends it only to the host it belongs to; the
  // list is fetched while the user types, and a half-typed URL must not
  // receive it.
  const listKey =
    settings?.api_key.revealable && apiKey.trim() === (settings.api_key.saved_value ?? '')
      ? ''
      : apiKey;
  // Fetch the model list once the endpoint (or a newly typed key) looks
  // complete, after a pause in typing.
  useEffect(() => {
    if (!loaded || !endpointValid) return;
    const timer = setTimeout(() => void loadModels(provider, endpoint, listKey, false), 600);
    return () => clearTimeout(timer);
  }, [loaded, provider, endpoint, listKey, endpointValid, loadModels]);
  useEffect(
    () => () => {
      modelsRequest.current?.abort();
      testRequest.current?.abort();
    },
    []
  );
  // A test result describes the fields it was run with; editing any of them
  // makes it stale.
  useEffect(() => {
    testRequest.current?.abort();
    setTestResult(null);
    setTesting(false);
  }, [provider, endpoint, model, apiKey]);

  const listed = models && modelsFor === endpoint.trim() ? models : null;
  const listedError = modelsError && modelsFor === endpoint.trim() ? modelsError : null;
  const modelListed = !listed || listed.models.some((m) => m.id === model.trim());

  const providerFromEnv = settings?.provider?.source === 'env';
  const urlFromEnv = settings?.proxy_url.source === 'env';
  const modelFromEnv = settings?.model.source === 'env';
  const keyFromEnv = settings?.api_key.source === 'env';
  const keyRevealable = settings?.api_key.revealable === true;
  const savedKey = keyRevealable ? (settings?.api_key.saved_value ?? '') : '';
  const savedHost = settings?.api_key.saved_host ?? '';
  const host = endpointHost(endpoint);
  const info = providerInfo(provider);
  const advice = endpointAdvice(endpoint, provider);

  // The key part of a save. A key shown in the field and kept while the
  // endpoint moves to another host is sent again, so the server binds it to
  // the new host instead of silently dropping it.
  const keyUpdate = (): AgentSettingsUpdate => {
    if (!settings || keyFromEnv) return {};
    const typed = apiKey.trim();
    if (!keyRevealable) return typed ? { api_key: typed } : {};
    if (typed === savedKey) {
      return savedKey && savedHost !== host && validAgentEndpoint(endpoint, provider)
        ? { api_key: savedKey }
        : {};
    }
    if (!typed) return settings.api_key.saved ? { clear_api_key: true } : {};
    return { api_key: typed };
  };

  const buildUpdate = (): AgentSettingsUpdate => {
    if (!settings) return {};
    const update: AgentSettingsUpdate = {};
    const providerChanged = !providerFromEnv && provider !== settings.provider.value;
    if (providerChanged) update.provider = provider;
    // The server checks the endpoint against the format, so a format change
    // always carries the endpoint with it.
    if (!urlFromEnv && (providerChanged || endpoint.trim() !== settings.proxy_url.value))
      update.proxy_url = endpoint.trim();
    if (!modelFromEnv && model.trim() !== settings.model.value) update.model = model.trim();
    return { ...update, ...keyUpdate() };
  };
  const changed = settings !== null && Object.keys(buildUpdate()).length > 0;

  const save = async (update: AgentSettingsUpdate, title: string) => {
    setSaving(true);
    try {
      apply(await saveAgentSettings(update));
      toast({ title });
      await check();
    } catch (err) {
      toast({
        title: 'Could not save agent settings',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!settings) return;
    void save(buildUpdate(), 'Agent settings saved');
  };

  const runTest = async () => {
    testRequest.current?.abort();
    const controller = new AbortController();
    testRequest.current = controller;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAgentEndpoint(
        {
          provider,
          proxy_url: endpoint.trim(),
          model: model.trim(),
          ...(apiKey.trim() && !keyFromEnv ? { api_key: apiKey.trim() } : {}),
        },
        controller.signal
      );
      if (!controller.signal.aborted) setTestResult({ result });
    } catch (err) {
      if (!controller.signal.aborted)
        setTestResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (testRequest.current === controller) setTesting(false);
    }
  };

  // Switching format keeps the host when it can (…/v1/messages ↔
  // …/v1/chat/completions), so a saved key stays bound to it.
  const switchProvider = (next: AgentProvider) => {
    if (next === provider) return;
    const swapped = swapEndpointFormat(endpoint, next);
    const trimmed = endpoint.trim();
    const isExample = providerInfo(provider).examples.some((e) => e.url === trimmed);
    if (swapped) setEndpoint(swapped);
    else if (!trimmed || isExample) setEndpoint(providerInfo(next).examples[0].url);
    if (!modelFromEnv) {
      if (next === 'openai' && model.trim().startsWith('claude-')) setModel('');
      if (next === 'anthropic' && !model.trim()) setModel(DEFAULT_ANTHROPIC_MODEL);
    }
    setProvider(next);
  };

  const reveal = () => {
    if (!revealStoragePath()) {
      toast({
        title: 'Reveal in Finder is only available in the LogSonic app',
        description: 'Copy the path instead.',
      });
    }
  };

  const mcpPath = settings?.mcp_config || mcp?.config || '';
  const disabled = settings === null || saving;

  return (
    <SettingsLayout>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>Agent</h2>
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          The model the agent talks to, and the MCP servers it can call.
        </p>
      </div>

      {(loadError || settings?.error) && (
        <p style={{ ...note, color: 'var(--ls-err)', marginBottom: 14 }}>
          {loadError ?? `${settings?.error}. Saving here replaces the file.`}{' '}
          {loadError && (
            <button type="button" className="underline" onClick={() => void load()}>
              Try again
            </button>
          )}
        </p>
      )}

      {/* Model endpoint */}
      <div style={card} data-testid="agent-model">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && !saving) submit();
          }}
        >
          <div className="flex items-center justify-between" style={rowStyle(true)}>
            <span style={label}>Connection</span>
            <span className="flex items-center" style={{ ...note, gap: 6 }} role="status">
              {checking ? (
                <Loader2 size={13} className="animate-spin" />
              ) : status?.available ? (
                <CheckCircle2 size={13} style={{ color: 'var(--ls-ok)' }} />
              ) : status ? (
                <XCircle size={13} style={{ color: 'var(--ls-err)' }} />
              ) : null}
              {checking
                ? 'Checking…'
                : status?.available
                  ? `Connected · ${status.model}`
                  : status?.reason || status?.error || ''}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Recheck saved connection"
                title="Recheck the saved connection"
                onClick={() => void check()}
                disabled={checking}
              >
                <RefreshCw size={13} />
              </Button>
            </span>
          </div>

          <div style={rowStyle(false)}>
            <span style={label} id="agent-format-label">
              API format
            </span>
            <div
              className="flex"
              role="radiogroup"
              aria-labelledby="agent-format-label"
              style={{ gap: 6, marginTop: 8 }}
            >
              {AGENT_PROVIDERS.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={provider === p.id}
                  variant={provider === p.id ? 'default' : 'outline'}
                  disabled={disabled || providerFromEnv}
                  onClick={() => switchProvider(p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
            <div style={{ ...note, marginTop: 6 }}>
              {providerFromEnv
                ? envNote('LOGSONIC_AGENT_PROVIDER')
                : provider === 'anthropic'
                  ? 'The Claude API, a local Claude proxy, or any gateway that speaks the Anthropic Messages API.'
                  : 'OpenAI, Ollama, LiteLLM, vLLM, LM Studio, OpenRouter or any server that speaks OpenAI Chat Completions. The model must support tool calls.'}
            </div>
          </div>

          <div style={rowStyle(false)}>
            <label htmlFor="agent-endpoint" style={label}>
              Endpoint URL
            </label>
            <Input
              id="agent-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              disabled={disabled || urlFromEnv}
              spellCheck={false}
              placeholder={info.examples[0].url}
              style={{ marginTop: 8, fontFamily: 'var(--ls-font-mono)', fontSize: 12.5 }}
            />
            <div style={{ ...note, marginTop: 6 }} data-testid="agent-endpoint-hint">
              {urlFromEnv ? (
                envNote('LOGSONIC_AGENT_PROXY_URL')
              ) : (
                <>
                  {advice && (
                    <div style={{ color: 'var(--ls-warn)', marginBottom: 4 }}>
                      {advice.problem}
                      {advice.suggestion && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="underline"
                            style={{ color: 'var(--ls-accent-text)' }}
                            onClick={() => setEndpoint(advice.suggestion as string)}
                          >
                            Use {advice.suggestion}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  The URL must end in <span className="ls-mono-inline">{info.suffix}</span>. For
                  example{' '}
                  {info.examples.map((e, i) => (
                    <span key={e.url}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        className="underline"
                        style={{ color: 'var(--ls-accent-text)' }}
                        disabled={disabled}
                        title={`Use ${e.url}`}
                        onClick={() => setEndpoint(e.url)}
                      >
                        <span className="ls-mono-inline">{e.url}</span>
                      </button>{' '}
                      ({e.label})
                    </span>
                  ))}
                  . Plain http:// only on localhost; use https:// for anything else.
                </>
              )}
            </div>
          </div>

          <div style={rowStyle(false)}>
            <label htmlFor="agent-model" style={label}>
              Model
            </label>
            <div className="flex items-center" style={{ gap: 6, marginTop: 8 }}>
              <Input
                id="agent-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={disabled || modelFromEnv}
                spellCheck={false}
                placeholder={
                  provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : 'gpt-5, llama3.1, qwen3…'
                }
                style={{ flex: 1 }}
              />
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Fetch models"
                    title={
                      endpointValid
                        ? 'Refresh the list of models this endpoint offers'
                        : 'Enter a valid endpoint to fetch its models'
                    }
                    disabled={disabled || modelFromEnv || !endpointValid}
                    onClick={() => void loadModels(provider, endpoint, listKey, true)}
                  >
                    <RefreshCw className={modelsLoading ? 'animate-spin' : undefined} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[380px] p-0">
                  {listed && listed.models.length > 0 ? (
                    <Command>
                      <CommandInput placeholder="Search models…" className="h-9" />
                      <CommandList>
                        <CommandEmpty>No model matches.</CommandEmpty>
                        <CommandGroup className="max-h-[300px] overflow-auto">
                          {listed.models.map((m) => (
                            <CommandItem
                              key={m.id}
                              value={`${m.id} ${m.name ?? ''}`}
                              onSelect={() => {
                                setModel(m.id);
                                setPickerOpen(false);
                              }}
                            >
                              <Check
                                size={13}
                                style={{ opacity: m.id === model.trim() ? 1 : 0, flexShrink: 0 }}
                              />
                              <span style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 12 }}>
                                {m.id}
                              </span>
                              {m.name && m.name !== m.id && (
                                <span style={{ ...note, marginLeft: 'auto' }}>{m.name}</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  ) : (
                    <div style={{ ...note, padding: 12 }}>
                      {modelsLoading
                        ? 'Fetching models…'
                        : listedError
                          ? listedError
                          : listed
                            ? 'The endpoint lists no models; type the model name.'
                            : 'No model list yet.'}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
            <div style={{ ...note, marginTop: 6 }} data-testid="agent-models-note">
              {modelFromEnv ? (
                envNote('LOGSONIC_AGENT_MODEL')
              ) : modelsLoading ? (
                `Fetching models from ${host}…`
              ) : listedError ? (
                <span style={{ color: 'var(--ls-warn)' }}>{listedError}</span>
              ) : listed ? (
                <>
                  {listed.models.length} {listed.models.length === 1 ? 'model' : 'models'} from{' '}
                  {host} ({STYLE_LABEL[listed.style]}). Pick one with the refresh button or type a
                  name.
                  {!modelListed && model.trim() !== '' && (
                    <div style={{ color: 'var(--ls-warn)', marginTop: 4 }}>
                      {model.trim()} is not in this endpoint's list.
                    </div>
                  )}
                </>
              ) : provider === 'anthropic' ? (
                'For example claude-sonnet-5-5 or claude-opus-5-5. The refresh button lists what the endpoint offers.'
              ) : (
                'The model name the server knows, such as gpt-5 or llama3.1. The refresh button lists what the endpoint offers.'
              )}
            </div>
          </div>

          <div style={rowStyle(false)}>
            <label htmlFor="agent-key" style={label}>
              API key
            </label>
            <div className="flex items-center" style={{ gap: 6, marginTop: 8 }}>
              <Input
                id="agent-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={disabled || keyFromEnv}
                placeholder={
                  keyFromEnv
                    ? 'Set by the environment'
                    : settings?.api_key.saved && !keyRevealable
                      ? `Saved ${settings.api_key.saved_hint} for ${savedHost} — type to replace`
                      : isLoopbackHost(host)
                        ? 'Optional for local servers'
                        : 'Paste your API key'
                }
                style={{ flex: 1, fontFamily: 'var(--ls-font-mono)', fontSize: 12.5 }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                title={showKey ? 'Hide the key' : 'Show the key'}
                aria-pressed={showKey}
                disabled={disabled || keyFromEnv || !apiKey}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Clear API key"
                title="Clear the key (Save to remove it)"
                disabled={disabled || keyFromEnv || !apiKey}
                onClick={() => setApiKey('')}
              >
                <X />
              </Button>
            </div>
            <div style={{ ...note, marginTop: 6 }}>
              {settings &&
                (keyFromEnv
                  ? envNote('LOGSONIC_AGENT_PROXY_KEY')
                  : keySourceLine(settings, endpoint))}
              {keyRevealable &&
                savedKey &&
                apiKey.trim() === savedKey &&
                savedHost &&
                savedHost !== host &&
                host && (
                  <div style={{ color: 'var(--ls-warn)', marginTop: 4 }}>
                    This key was saved for {savedHost}. Saving sends it to {host} from now on. Clear
                    it or paste the key for {host} if it is a different service.
                  </div>
                )}
              {!keyRevealable && settings?.api_key.saved && savedHost !== host && !keyFromEnv && (
                <div style={{ color: 'var(--ls-warn)', marginTop: 4 }}>
                  The saved key belongs to {savedHost} and is not sent to {host || 'this endpoint'}.
                  Enter the key again for this endpoint.
                </div>
              )}
              <div style={{ marginTop: 4 }}>
                {keyRevealable || !settings?.api_key.saved
                  ? 'Stored on this computer only and sent only to the endpoint above.'
                  : 'Stored on this computer only. Open Settings in the LogSonic app to see it.'}{' '}
                {settings?.api_key.saved && !keyFromEnv && !keyRevealable && (
                  <button
                    type="button"
                    className="underline"
                    disabled={saving}
                    onClick={() => void save({ clear_api_key: true }, 'API key removed')}
                    style={{ color: 'var(--ls-accent-text)' }}
                  >
                    Remove saved key
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={rowStyle(false)}>
            <div className="flex items-center justify-between" style={{ gap: 8 }}>
              <span style={note}>
                Saved to <span className="ls-mono-inline">{settings?.path ?? 'agent.json'}</span>,
                readable only by you. Environment variables win over saved values.
              </span>
              <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || testing || !endpointValid || !model.trim()}
                  title={
                    !endpointValid
                      ? `Enter an endpoint ending in ${info.suffix} first`
                      : !model.trim()
                        ? 'Enter a model first'
                        : 'Send one short request with these fields, without saving'
                  }
                  onClick={() => void runTest()}
                >
                  {testing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                  {testing ? 'Testing…' : 'Test'}
                </Button>
                <Button type="submit" size="sm" disabled={!changed || saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
            {testResult && (
              <div
                role="status"
                data-testid="agent-test-result"
                className="flex items-start"
                style={{
                  ...note,
                  gap: 6,
                  marginTop: 8,
                  color: testResult.result ? 'var(--ls-ok)' : 'var(--ls-err)',
                }}
              >
                {testResult.result ? (
                  <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                ) : (
                  <XCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                )}
                <span style={{ wordBreak: 'break-word' }}>
                  {testResult.result
                    ? `Works: ${testResult.result.model} at ${testResult.result.host} answered in ${testResult.result.latency_ms} ms${
                        testResult.result.reply ? ` ("${testResult.result.reply}")` : ''
                      }.${changed ? ' Save to use these settings.' : ''}`
                    : testResult.error}
                </span>
              </div>
            )}
          </div>
        </form>
      </div>

      {/* MCP servers */}
      <div style={card} data-testid="agent-mcp">
        <div className="flex items-center justify-between" style={rowStyle(true)}>
          <span style={label}>MCP servers</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void loadMcp()}
            disabled={mcpLoading}
          >
            {mcpLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Recheck
          </Button>
        </div>
        <div style={{ ...rowStyle(false), ...note }}>
          The agent can call tools from other MCP servers: a ticket tracker, runbooks, deploy
          history. Servers are added by editing <span className="ls-mono-inline">mcp.json</span> on
          disk, not from this page, so that no web page or log line can make LogSonic start a
          program. The format is the <span className="ls-mono-inline">mcpServers</span> format
          Claude Desktop and Claude Code use. Edits are picked up on the next agent request, with no
          restart.{' '}
          <a
            href={MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center underline"
            style={{ gap: 3, color: 'var(--ls-accent-text)' }}
          >
            Format reference <ExternalLink size={11} />
          </a>
        </div>
        <div className="flex items-center justify-between" style={rowStyle(false)}>
          <span style={label}>Config file</span>
          <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
            {mcpPath ? (
              <CopyableValue value={mcpPath} maxWidth={420} />
            ) : (
              <span style={note}>…</span>
            )}
            {isNativeShell() && settings?.mcp_config_in_storage && (
              <Button type="button" size="sm" variant="outline" onClick={reveal}>
                <FolderOpen size={13} />
                Show in Finder
              </Button>
            )}
          </div>
        </div>
        <div style={rowStyle(false)}>
          {mcpPath && (
            <CopyBlock
              label={`1. Create or open the file in your editor${isMac() ? ' (Terminal)' : ''}`}
              value={editCommand(mcpPath)}
            />
          )}
          <CopyBlock label="2. Add servers, then save the file" value={MCP_EXAMPLE} />
          <div style={note}>
            3. Click Recheck. Use <span className="ls-mono-inline">tools</span> to list only the
            tools the agent may use, and <span className="ls-mono-inline">"disabled": true</span> to
            keep an entry without starting it. Set LOGSONIC_AGENT_MCP_CONFIG to use another file.
          </div>
        </div>

        <div style={rowStyle(false)} data-testid="agent-mcp-servers">
          {mcpError ? (
            <span style={{ ...note, color: 'var(--ls-err)' }}>{mcpError}</span>
          ) : !mcp ? (
            <span style={note}>Loading…</span>
          ) : (
            <>
              {mcp.config_error && (
                <div style={{ ...note, color: 'var(--ls-err)', marginBottom: 6 }}>
                  {mcp.config_error}
                </div>
              )}
              {mcp.skipped && mcp.skipped.length > 0 && (
                <div style={{ ...note, color: 'var(--ls-err)', marginBottom: 6 }}>
                  Skipped: {mcp.skipped.join('; ')}
                </div>
              )}
              {mcp.servers.length === 0 ? (
                <span style={note}>
                  {mcp.config_exists ? 'The file lists no servers.' : 'No mcp.json yet.'}
                </span>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {mcp.servers.map((server) => (
                    <li key={server.name} style={{ padding: '6px 0' }}>
                      <div className="flex items-center" style={{ gap: 6, fontSize: 12.5 }}>
                        {server.disabled ? (
                          <XCircle size={13} style={{ color: 'var(--ls-text-4)' }} />
                        ) : server.connected ? (
                          <CheckCircle2 size={13} style={{ color: 'var(--ls-ok)' }} />
                        ) : (
                          <XCircle size={13} style={{ color: 'var(--ls-err)' }} />
                        )}
                        <strong>{server.name}</strong>
                        <span style={note}>
                          {server.transport} · {server.target}
                          {server.disabled
                            ? ' · disabled'
                            : server.connected
                              ? ` · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`
                              : ''}
                        </span>
                      </div>
                      {server.error && (
                        <div style={{ ...note, color: 'var(--ls-err)', marginLeft: 19 }}>
                          {server.error}
                        </div>
                      )}
                      {server.connected && server.tools.length > 0 && (
                        <div
                          className="ls-mono-inline"
                          style={{ ...note, marginLeft: 19, wordBreak: 'break-word' }}
                        >
                          {server.tools.join(', ')}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </SettingsLayout>
  );
};

export default AgentSettings;
