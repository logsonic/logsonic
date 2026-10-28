import {
  ArrowUp,
  BarChart3,
  ChevronRight,
  Copy,
  Database,
  Download,
  History,
  LayoutPanelTop,
  Loader2,
  MonitorSmartphone,
  Plus,
  RotateCcw,
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

import { fetchAgentStatus, streamAgentChat, type AgentStatus } from '@/lib/agent-stream';
import {
  buildMessages,
  plural,
  reduceTurn,
  stepError,
  stepSummary,
  toolLabel,
} from '@/lib/agent-turns';
import { applyStepView, stepView } from '@/lib/agent-view';
import {
  useActiveSession,
  useAgentStore,
  type AgentSession,
  type AgentStep,
  type AgentTurn,
} from '@/stores/useAgentStore';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import './Agent.css';

function ToolIcon({ tool }: { tool: string }) {
  const size = 13;
  if (tool.startsWith('ingest_')) return <Download size={size} />;
  if (tool.startsWith('ui_')) return <MonitorSmartphone size={size} />;
  if (tool === 'list_sources') return <Database size={size} />;
  if (tool === 'log_histogram' || tool === 'compare_windows') return <BarChart3 size={size} />;
  if (tool === 'facet_logs' || tool === 'analyze_logs') return <LayoutPanelTop size={size} />;
  if (tool === 'log_context') return <ScanSearch size={size} />;
  return <Search size={size} />;
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
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
}: {
  sessions: AgentSession[];
  activeId: string | null;
  onPick: () => void;
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
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const request = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const starters = useStarters();

  const turns = session?.turns ?? [];
  const pending = turns.some((turn) => turn.pending);

  useEffect(() => {
    const controller = new AbortController();
    fetchAgentStatus(controller.signal)
      .then(setStatus)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStatusError(error instanceof Error ? error.message : 'Status request failed.');
        }
      });
    return () => controller.abort();
  }, []);

  // Abort only when the panel unmounts, not on every re-render.
  useEffect(() => () => request.current?.abort(), []);

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
    stick.current = true;
    let imported = false;
    try {
      await streamAgentChat(
        buildMessages(history),
        (event) => {
          if (
            event.type === 'step' &&
            event.step.tool.startsWith('ingest_') &&
            !event.step.is_error
          ) {
            imported = true;
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
        controller.signal
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
      if (request.current === controller) request.current = null;
      if (imported) onDataChanged?.();
    }
  };

  const unavailable = status?.available === false;

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt || pending || unavailable) return;
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
    if (!session || pending || turns.length === 0) return;
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && pending) {
      event.preventDefault();
      request.current?.abort();
    }
  };

  const statusText = statusError
    ? 'Status unavailable'
    : !status
      ? 'Connecting'
      : unavailable
        ? 'Unavailable'
        : status.model || 'Ready';

  return (
    <section className="ls-agent" aria-label="Agent">
      <header className="ls-agent-head">
        <div className="ls-agent-head-title">
          <strong>{showHistory ? 'Investigations' : session?.title || 'New investigation'}</strong>
          <span
            className={`ls-agent-status${unavailable || statusError ? ' is-down' : status ? ' is-up' : ''}`}
            role="status"
          >
            {statusText}
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
            disabled={pending}
            onClick={() => {
              newSession();
              setShowHistory(false);
            }}
          >
            <Plus size={16} />
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
        {(statusError || unavailable) && (
          <div className="ls-agent-unavailable" role="alert">
            {statusError
              ? `Cannot reach the agent: ${statusError}`
              : status?.reason || status?.error || 'The agent is not configured on this server.'}
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
              onClick={() => request.current?.abort()}
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
        <p className="ls-agent-note">
          Log excerpts the agent reads are sent to Claude through your local proxy.
        </p>
      </div>
    </section>
  );
}
