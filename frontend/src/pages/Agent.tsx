import {
  ArrowUp,
  BarChart3,
  Bookmark,
  ChevronRight,
  Copy,
  Database,
  Download,
  History,
  LayoutPanelTop,
  Loader2,
  MonitorSmartphone,
  Plug,
  Plus,
  RotateCcw,
  Settings,
  ScanSearch,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { useLocation, useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';

import {
  fetchAgentStatus,
  streamAgentChat,
  type AgentStatus,
  type AgentStreamEvent,
} from '@/lib/agent-stream';
import {
  buildMessages,
  externalTool,
  plural,
  reduceTurn,
  stepError,
  stepSummary,
  toolLabel,
} from '@/lib/agent-turns';
import { applyStepView, stepView } from '@/lib/agent-view';
import { API_BASE_URL } from '@/lib/api-client';
import {
  useActiveSession,
  useAgentStore,
  type AgentSession,
  type AgentStep,
  type AgentTurn,
} from '@/stores/useAgentStore';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import './Agent.css';

function ToolIcon({ tool }: { tool: string }) {
  const size = 13;
  if (externalTool(tool)) return <Plug size={size} />;
  if (tool.startsWith('ingest_')) return <Download size={size} />;
  if (tool.startsWith('ui_')) return <MonitorSmartphone size={size} />;
  if (tool === 'save_view') return <Bookmark size={size} />;
  if (tool === 'list_sources') return <Database size={size} />;
  if (tool === 'log_histogram' || tool === 'compare_windows') return <BarChart3 size={size} />;
  if (tool === 'facet_logs' || tool === 'analyze_logs') return <LayoutPanelTop size={size} />;
  if (tool === 'log_context' || tool === 'log_patterns') return <ScanSearch size={size} />;
  return <Search size={size} />;
}

function proxyEndpointNote(proxyUrl?: string): string {
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        host &&
        host !== 'localhost' &&
        host !== '127.0.0.1' &&
        host !== '::1' &&
        host !== '[::1]'
      ) {
        return `Log excerpts the agent reads are sent to the configured model endpoint (${parsed.host}).`;
      }
    } catch {
      // Keep default copy when proxyUrl is not a valid URL.
    }
  }
  return 'Log excerpts the agent reads are sent to the model behind your local endpoint.';
}

const TABLE_TOOLS = new Set([
  'ui_show_view',
  'ui_set_query',
  'ui_set_time',
  'ui_set_sources',
  'ui_add_filter',
  'ui_remove_filter',
  'ui_clear_filters',
]);

function StepRow({ step }: { step: AgentStep }) {
  const navigate = useNavigate();
  const location = useLocation();
  const viewStepId = useAgentStore((state) => state.viewStepId);
  const setViewStep = useAgentStore((state) => state.setViewStep);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const view = stepView(step);
  const error = step.status === 'done' ? null : stepError(step);
  const onScreen = viewStepId === step.id;

  const show = async () => {
    if (!view) return;
    setApplying(true);
    setApplyError('');
    try {
      await applyStepView(view, { route: location.pathname, navigate });
      setViewStep(step.id);
      // On narrow screens the dock covers the table; step aside to show it.
      if (window.matchMedia?.('(max-width: 820px)').matches) {
        useAgentStore.getState().setPanelOpen(false);
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Could not apply this view.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <li
      className={`ls-step is-${step.status}${error && step.status !== 'running' ? ' is-error' : ''}${onScreen ? ' is-on-screen' : ''}`}
    >
      <span className="ls-step-node" aria-hidden="true">
        {step.status === 'running' ? (
          <Loader2 size={13} className="ls-spin" />
        ) : (
          <ToolIcon tool={step.tool} />
        )}
      </span>
      <details className="ls-step-body">
        <summary>
          <span className="ls-step-title">{toolLabel(step.tool)}</span>
          <span className="ls-step-summary">{stepSummary(step)}</span>
          <ChevronRight size={13} className="ls-step-chevron" aria-hidden="true" />
        </summary>
        <div className="ls-step-detail">
          <div>
            <span>Input</span>
            <pre>{JSON.stringify(step.input ?? {}, null, 2)}</pre>
          </div>
          {step.status !== 'running' && (
            <div>
              <span>Output</span>
              <pre>
                {typeof step.output === 'string'
                  ? step.output
                  : JSON.stringify(step.output ?? null, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </details>
      {(view || onScreen) && (
        <button
          type="button"
          className="ls-step-show"
          onClick={show}
          disabled={applying || !view}
          title="Apply this step's query, sources and time range to the log table"
        >
          {onScreen ? 'In table' : applying ? 'Applying…' : 'Show in table'}
        </button>
      )}
      {applyError && <span className="ls-step-apply-error">{applyError}</span>}
    </li>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="ls-agent-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>{alt || ''}</span>,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function elapsed(turn: AgentTurn): string {
  if (!turn.finishedAt) return '';
  const seconds = Math.max(1, Math.round((turn.finishedAt - turn.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function TurnView({
  turn,
  isLast,
  onRetry,
}: {
  turn: AgentTurn;
  isLast: boolean;
  onRetry: () => void;
}) {
  // Group consecutive steps into one trail so prose and actions alternate cleanly.
  const groups: Array<{ kind: 'text'; text: string } | { kind: 'steps'; steps: AgentStep[] }> = [];
  for (const item of turn.items) {
    if (item.kind === 'text') {
      if (item.text.trim()) groups.push({ kind: 'text', text: item.text });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'steps') last.steps.push(item.step);
      else groups.push({ kind: 'steps', steps: [item.step] });
    }
  }
  const lastItem = turn.items[turn.items.length - 1];
  const thinking =
    turn.pending &&
    !(lastItem?.kind === 'step' && lastItem.step.status === 'running') &&
    !(lastItem?.kind === 'text' && lastItem.text);
  const [copied, setCopied] = useState(false);

  return (
    <div className="ls-turn">
      <div className="ls-turn-user">
        <p>{turn.user}</p>
      </div>
      <div className="ls-turn-agent">
        {groups.map((group, index) =>
          group.kind === 'text' ? (
            <Markdown key={index} text={group.text} />
          ) : (
            <ol key={index} className="ls-trail" aria-label="Agent actions">
              {group.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>
          )
        )}
        {turn.pending && lastItem?.kind === 'text' && lastItem.text && (
          <span className="ls-caret" aria-hidden="true" />
        )}
        {thinking && (
          <div className="ls-thinking" role="status">
            <span className="ls-thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {turn.items.length ? 'Reading results' : 'Planning the investigation'}
          </div>
        )}
        {turn.error && (
          <div className="ls-turn-error" role="alert">
            <span>{turn.error}</span>
            {isLast && (
              <button type="button" onClick={onRetry}>
                <RotateCcw size={12} /> Retry
              </button>
            )}
          </div>
        )}
        {!turn.pending && turn.answer && (
          <div className="ls-turn-meta">
            <span>
              {elapsed(turn)}
              {turn.items.some((item) => item.kind === 'step') &&
                `, ${plural(turn.items.filter((item) => item.kind === 'step').length, 'action')}`}
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(turn.answer || '');
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy size={12} /> {copied ? 'Copied' : 'Copy answer'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

function HistoryList({
  sessions,
  activeId,
  onPick,
  locked,
}: {
  sessions: AgentSession[];
  activeId: string | null;
  onPick: () => void;
  locked: boolean;
}) {
  const selectSession = useAgentStore((state) => state.selectSession);
  const deleteSession = useAgentStore((state) => state.deleteSession);
  if (sessions.length === 0) {
    return <p className="ls-history-empty">Past investigations appear here.</p>;
  }
  return (
    <ul className="ls-history" aria-label="Past investigations">
      {sessions.map((session) => (
        <li key={session.id} className={session.id === activeId ? 'is-active' : undefined}>
          <button
            type="button"
            className="ls-history-open"
            disabled={locked}
            onClick={() => {
              selectSession(session.id);
              onPick();
            }}
          >
            <strong>{session.title}</strong>
            <small>
              {plural(session.turns.length, 'question')}, {relativeTime(session.updatedAt)}
            </small>
          </button>
          <button
            type="button"
            className="ls-history-delete"
            aria-label={`Delete ${session.title}`}
            disabled={locked}
            onClick={() => deleteSession(session.id)}
          >
            <Trash2 size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function useStarters() {
  const sources = useSystemInfoStore((state) => state.systemInfo?.storage_info?.source_names);
  return useMemo(() => {
    const investigate = [
      'What errors stand out, and when did they start?',
      'Find the biggest spike and explain what caused it.',
      'Compare the last hour with the hour before it.',
    ];
    const bring = [
      'Import logs from /absolute/path/to/folder and summarize the errors.',
      'Import CloudWatch group /aws/lambda/name with profile default in us-east-1.',
    ];
    return sources && sources.length > 0
      ? { investigate, bring, sources }
      : { investigate: [], bring, sources: [] };
  }, [sources]);
}

export default function Agent({
  onClose,
  onDataChanged,
}: {
  onClose?: () => void;
  onDataChanged?: () => void;
}) {
  const session = useActiveSession();
  const sessions = useAgentStore((state) => state.sessions);
  const activeId = useAgentStore((state) => state.activeId);
  const startTurn = useAgentStore((state) => state.startTurn);
  const updateLastTurn = useAgentStore((state) => state.updateLastTurn);
  const newSession = useAgentStore((state) => state.newSession);
  const approvedInvestigations = useAgentStore((state) => state.approvedInvestigations);
  const grantInvestigation = useAgentStore((state) => state.grantInvestigation);
  const revokeInvestigation = useAgentStore((state) => state.revokeInvestigation);
  const navigate = useNavigate();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [runningRequest, setRunningRequest] = useState(false);
  const [approval, setApproval] = useState<
    (Extract<AgentStreamEvent, { type: 'approval_required' }> & { sessionId: string }) | null
  >(null);
  const [approvalError, setApprovalError] = useState('');
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const approvalSubmittingRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const starters = useStarters();

  const turns = session?.turns ?? [];
  const pending = turns.some((turn) => turn.pending);

  // Load the status on open and again after each turn: the first turn is
  // what connects external MCP servers, so their tool count appears then.
  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    fetchAgentStatus(controller.signal)
      .then(setStatus)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStatusError(error instanceof Error ? error.message : 'Status request failed.');
        }
      });
    return () => controller.abort();
  }, [pending]);

  // Abort only when the panel unmounts, not on every re-render.
  useEffect(() => () => request.current?.abort(), []);

  const clearApproval = () => {
    setApproval(null);
    setApprovalError('');
    setApprovalSubmitting(false);
    approvalSubmittingRef.current = false;
  };

  const stop = () => {
    clearApproval();
    request.current?.abort();
  };

  const decideApproval = async (approve: boolean, approveAll = false) => {
    if (
      !approval ||
      approvalSubmittingRef.current ||
      !request.current ||
      request.current.signal.aborted
    )
      return;
    const current = approval;
    const controller = request.current;
    const signal = controller.signal;
    const revision = useAgentStore.getState().grantRevisions[current.sessionId] ?? 0;
    approvalSubmittingRef.current = true;
    setApprovalSubmitting(true);
    setApprovalError('');
    try {
      const response = await fetch(`${API_BASE_URL}/agent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: current.id,
          approve,
          ...(approveAll ? { approve_all: true } : {}),
        }),
        signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : `Approval request failed (${response.status}).`
        );
      }
      if (
        approveAll &&
        !signal.aborted &&
        useAgentStore.getState().sessions.some((session) => session.id === current.sessionId)
      ) {
        grantInvestigation(current.sessionId, revision);
      }
      if (request.current === controller && !signal.aborted) {
        clearApproval();
      }
    } catch (error) {
      if (request.current === controller && !signal.aborted)
        setApprovalError(error instanceof Error ? error.message : 'Approval request failed.');
    } finally {
      if (request.current === controller && !signal.aborted) {
        approvalSubmittingRef.current = false;
        setApprovalSubmitting(false);
      }
    }
  };

  // Follow the stream unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    input.current?.focus();
  }, [activeId]);

  const autosize = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(autosize, [draft]);

  const run = async (sessionId: string, history: AgentTurn[]) => {
    const controller = new AbortController();
    request.current = controller;
    setRunningRequest(true);
    stick.current = true;
    let imported = false;
    try {
      await streamAgentChat(
        buildMessages(history),
        (event) => {
          if (request.current !== controller || controller.signal.aborted) return;
          if (event.type === 'approval_required') {
            setApproval({ ...event, sessionId });
            setApprovalError('');
            return;
          }
          if (event.type === 'done' || event.type === 'error') clearApproval();
          if (
            event.type === 'step' &&
            event.step.tool.startsWith('ingest_') &&
            !event.step.is_error
          ) {
            imported = true;
            // Load the new source names now, before the agent selects the
            // imported source in the view.
            void useSystemInfoStore
              .getState()
              .refreshSystemInfo(true)
              .catch(() => undefined);
          }
          if (event.type === 'step' && event.step.tool === 'save_view' && !event.step.is_error) {
            void useWorkspaceStore
              .getState()
              .refreshWorkspaces()
              .catch(() => undefined);
          }
          // A UI tool that changed the table becomes the step "in table".
          if (
            event.type === 'step' &&
            TABLE_TOOLS.has(event.step.tool) &&
            !event.step.is_error &&
            event.step.id
          ) {
            useAgentStore.getState().setViewStep(event.step.id);
          }
          updateLastTurn(sessionId, (turn) => reduceTurn(turn, event));
        },
        controller.signal,
        Boolean(useAgentStore.getState().approvedInvestigations[sessionId])
      );
    } catch (error) {
      updateLastTurn(sessionId, (turn) =>
        reduceTurn(turn, {
          type: 'error',
          error: controller.signal.aborted
            ? 'Stopped.'
            : error instanceof Error
              ? error.message
              : 'The request failed.',
          steps: [],
        })
      );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setRunningRequest(false);
        clearApproval();
      }
      if (imported) onDataChanged?.();
    }
  };

  const unavailable = status?.available === false;

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt || pending || request.current || unavailable) return;
    const sessionId = startTurn(prompt);
    setDraft('');
    setShowHistory(false);
    const current = useAgentStore.getState().sessions.find((s) => s.id === sessionId);
    void run(sessionId, current?.turns ?? []);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    send(draft);
  };

  const retry = () => {
    if (!session || pending || request.current || turns.length === 0) return;
    const last = turns[turns.length - 1];
    updateLastTurn(session.id, () => ({
      user: last.user,
      items: [],
      pending: true,
      startedAt: Date.now(),
    }));
    const current = useAgentStore.getState().sessions.find((s) => s.id === session.id);
    void run(session.id, current?.turns ?? []);
  };

  const requireApprovals = () => {
    if (!activeId) return;
    revokeInvestigation(activeId);
    if (request.current) stop();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && pending) {
      event.preventDefault();
      stop();
    }
  };

  const statusText = statusError
    ? 'Status unavailable'
    : !status
      ? 'Connecting'
      : unavailable
        ? 'Unavailable'
        : status.model || 'Ready';
  const mcp = status?.mcp;
  const mcpText = mcp && mcp.tools > 0 ? ` · ${plural(mcp.tools, 'external tool')}` : '';
  const statusTitle = mcp
    ? `External MCP servers: ${mcp.connected} of ${mcp.servers} connected, from ${mcp.config}`
    : undefined;

  return (
    <section className="ls-agent" aria-label="Agent">
      <header className="ls-agent-head">
        <div className="ls-agent-head-title">
          <strong>{showHistory ? 'Investigations' : session?.title || 'New investigation'}</strong>
          <span
            className={`ls-agent-status${unavailable || statusError ? ' is-down' : status ? ' is-up' : ''}`}
            role="status"
            title={statusTitle}
          >
            {statusText}
            {mcpText}
          </span>
        </div>
        <div className="ls-agent-head-actions">
          <button
            type="button"
            aria-label="Past investigations"
            aria-pressed={showHistory}
            title="Past investigations"
            onClick={() => setShowHistory((value) => !value)}
          >
            <History size={15} />
          </button>
          <button
            type="button"
            aria-label="New investigation"
            title="New investigation"
            disabled={pending || runningRequest}
            onClick={() => {
              newSession();
              setShowHistory(false);
            }}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            aria-label="Agent settings"
            title="Model and MCP servers"
            onClick={() => navigate('/settings/agent')}
          >
            <Settings size={15} />
          </button>
          {onClose && (
            <button type="button" aria-label="Close agent" title="Close (⌘J)" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      <div
        className="ls-agent-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {showHistory ? (
          <HistoryList
            sessions={sessions}
            activeId={activeId}
            onPick={() => setShowHistory(false)}
            locked={runningRequest}
          />
        ) : turns.length === 0 ? (
          <div className="ls-agent-empty">
            <h2>Ask about your logs</h2>
            <p>
              The agent searches, charts and compares what is indexed, then drives the table beside
              it so you can check every claim.
            </p>
            {starters.investigate.length > 0 && (
              <div className="ls-agent-prompts" aria-label="Suggested questions">
                {starters.investigate.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={unavailable}
                    onClick={() => send(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            <div className="ls-agent-prompts is-secondary" aria-label="Bring in logs">
              {starters.bring.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={unavailable}
                  onClick={() => {
                    setDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ls-agent-thread" aria-live="polite">
            {turns.map((turn, index) => (
              <TurnView
                key={`${session?.id}-${index}`}
                turn={turn}
                isLast={index === turns.length - 1}
                onRetry={retry}
              />
            ))}
          </div>
        )}
      </div>

      <div className="ls-agent-foot">
        {activeId && approvedInvestigations[activeId] && (
          <div className="ls-agent-grant" role="status">
            <span>All tools approved for this investigation</span>
            <button type="button" onClick={requireApprovals}>
              Require approvals
            </button>
          </div>
        )}
        {approval && (
          <section className="ls-agent-approval" role="region" aria-label="Tool approval required">
            <p>
              <strong>{approval.reason}</strong> · <code>{approval.tool}</code>
            </p>
            <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            {approvalError && (
              <p className="ls-agent-approval-error" role="alert">
                {approvalError}
              </p>
            )}
            <div className="ls-agent-approval-actions">
              <button
                type="button"
                disabled={approvalSubmitting}
                onClick={() => void decideApproval(false)}
              >
                Deny
              </button>
              <button
                type="button"
                disabled={approvalSubmitting}
                onClick={() => void decideApproval(true, true)}
              >
                Approve all for this investigation
              </button>
              <button
                type="button"
                disabled={approvalSubmitting}
                onClick={() => void decideApproval(true)}
              >
                Approve once
              </button>
            </div>
          </section>
        )}
        {(statusError || unavailable) && (
          <div className="ls-agent-unavailable" role="alert">
            {statusError
              ? `Cannot reach the agent: ${statusError}`
              : status?.reason ||
                status?.error ||
                'The agent is not configured on this server.'}{' '}
            <button
              type="button"
              className="ls-agent-settings-link"
              onClick={() => navigate('/settings/agent')}
            >
              Open agent settings
            </button>
          </div>
        )}
        <form className="ls-agent-compose" onSubmit={submit}>
          <label className="sr-only" htmlFor="ls-agent-input">
            Message the agent
          </label>
          <textarea
            id="ls-agent-input"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={turns.length ? 'Ask a follow-up' : 'Ask a question or name a log source'}
            disabled={unavailable}
          />
          {pending ? (
            <button
              className="ls-agent-send is-stop"
              type="button"
              onClick={stop}
              aria-label="Stop"
              title="Stop (Esc)"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="ls-agent-send"
              type="submit"
              disabled={!draft.trim() || unavailable}
              aria-label="Send message"
              title="Send (Enter)"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </form>
        <p className="ls-agent-note">{proxyEndpointNote(status?.proxy_url)}</p>
      </div>
    </section>
  );
}
