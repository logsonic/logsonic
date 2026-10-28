import type { AgentMessage, AgentStreamEvent, AgentWireStep } from '@/lib/agent-stream';
import type { AgentItem, AgentStep, AgentTurn } from '@/stores/useAgentStore';

const toolNames: Record<string, string> = {
  ingest_local: 'Import local logs',
  ingest_remote: 'Import remote logs',
  ingest_cloudwatch: 'Import CloudWatch logs',
  list_sources: 'List sources',
  query_logs: 'Search logs',
  search_logs: 'Search logs',
  analyze_logs: 'Sample and summarize',
  facet_logs: 'Break down fields',
  log_histogram: 'Chart events over time',
  log_context: 'Read surrounding events',
  compare_windows: 'Compare time windows',
  log_patterns: 'Scan for rare patterns',
  save_view: 'Save view',
  ui_get_state: 'Read the current view',
  ui_navigate: 'Change page',
  ui_show_view: 'Update the log view',
  ui_set_query: 'Set search query',
  ui_set_time: 'Set time range',
  ui_set_sources: 'Select sources',
  ui_set_columns: 'Change columns',
  ui_set_column_widths: 'Resize columns',
  ui_add_filter: 'Apply filter',
  ui_remove_filter: 'Remove filter',
  ui_clear_filters: 'Clear filters',
  ui_set_sort: 'Sort results',
  ui_set_page: 'Change results page',
  ui_fields_panel: 'Change fields panel',
  ui_sidebar: 'Change sidebar',
  ui_open_workspace: 'Open workspace',
  ui_run_search: 'Refresh results',
};

/** Splits mcp__<server>__<tool> into its parts, or null for LogSonic tools. */
export function externalTool(tool: string): { server: string; name: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool);
  return match ? { server: match[1], name: match[2] } : null;
}

export function toolLabel(tool: string): string {
  const external = externalTool(tool);
  if (external) return `${external.server} · ${external.name}`;
  return toolNames[tool] || tool.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export function stepError(step: AgentStep): string | null {
  const output = step.output;
  if (output && typeof output === 'object' && 'error' in output) {
    const error = (output as { error: unknown }).error;
    if (typeof error === 'string') return error;
  }
  return step.status === 'error' ? 'Did not finish.' : null;
}

export const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  return null;
}

export function stepSummary(step: AgentStep): string {
  if (step.status === 'running') {
    return (
      firstString(step.input || {}, ['query', 'path', 'url', 'log_group', 'source']) || 'Working…'
    );
  }
  const error = stepError(step);
  if (error) return error;
  const output = step.output;
  if (output && typeof output === 'object') {
    const value = output as Record<string, unknown>;
    const state = value.state as Record<string, unknown> | undefined;
    if (state && typeof state === 'object' && typeof state.result_count === 'number') {
      return `${plural(state.result_count, 'matching event')} on screen`;
    }
    if (Array.isArray(value.buckets) && typeof value.total_count === 'number') {
      return `${plural(value.total_count, 'event')} in ${plural(value.buckets.length, 'bucket')}`;
    }
    if (Array.isArray(value.fields)) return `${plural(value.fields.length, 'field')} broken down`;
    if (step.tool === 'log_context' && Array.isArray(value.logs)) {
      return plural(value.logs.length, 'nearby event');
    }
    if (externalTool(step.tool) && typeof value.text === 'string') {
      const first = value.text.split('\n').find((line) => line.trim()) || 'Done';
      return first.length > 120 ? `${first.slice(0, 119)}…` : first;
    }
    if (step.tool === 'log_patterns' && typeof value.scanned === 'number') {
      const patterns = typeof value.distinct_patterns === 'number' ? value.distinct_patterns : 0;
      return `${plural(patterns, 'pattern')} in ${plural(value.scanned, 'event')}`;
    }
    if (step.tool === 'save_view' && typeof value.name === 'string') {
      const rows =
        typeof value.matching_rows === 'number' ? ` (${plural(value.matching_rows, 'event')})` : '';
      return `Saved “${value.name}”${rows}`;
    }
    const baseline = value.baseline as Record<string, unknown> | undefined;
    const incident = value.incident as Record<string, unknown> | undefined;
    if (typeof baseline?.total_count === 'number' && typeof incident?.total_count === 'number') {
      const ratio = typeof value.rate_ratio === 'number' ? `, ${value.rate_ratio}× the rate` : '';
      return `${baseline.total_count.toLocaleString()} before, ${incident.total_count.toLocaleString()} during${ratio}`;
    }
    if (typeof value.total_count === 'number') return plural(value.total_count, 'matching event');
    if (typeof value.rows_stored === 'number')
      return `${plural(value.rows_stored, 'event')} imported`;
    if (value.import && typeof value.import === 'object') {
      const stored = (value.import as Record<string, unknown>).rows_stored;
      if (typeof stored === 'number') return `${plural(stored, 'event')} imported`;
    }
    if (Array.isArray(value.imports)) {
      const stored = value.imports.reduce(
        (sum: number, entry) =>
          sum + (Number((entry as Record<string, unknown>)?.rows_stored) || 0),
        0
      );
      return `${plural(value.imports.length, 'file')}, ${plural(stored, 'event')} imported`;
    }
    if (Array.isArray(value.sources)) return plural(value.sources.length, 'source');
    if (typeof value.count === 'number') return plural(value.count, 'result');
  }
  return firstString(step.input || {}, ['query', 'path', 'url', 'log_group', 'source']) || 'Done';
}

const wireToStep = (wire: AgentWireStep, fallbackId: string): AgentStep => {
  const failed =
    wire.is_error === true ||
    Boolean(wire.output && typeof wire.output === 'object' && 'error' in wire.output);
  return {
    id: wire.id || fallbackId,
    tool: wire.tool,
    input: wire.input || {},
    output: wire.output,
    status: failed ? 'error' : 'done',
  };
};

/** Fold one stream event into a turn. Pure, so it is easy to test. */
export function reduceTurn(turn: AgentTurn, event: AgentStreamEvent): AgentTurn {
  const items = turn.items.slice();
  switch (event.type) {
    case 'text': {
      const last = items[items.length - 1];
      if (last?.kind === 'text' && last.round === event.round) {
        items[items.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        items.push({ kind: 'text', round: event.round, text: event.delta });
      }
      return { ...turn, items };
    }
    case 'step_start':
      items.push({
        kind: 'step',
        step: { id: event.id, tool: event.tool, input: event.input, status: 'running' },
      });
      return { ...turn, items };
    case 'step': {
      const step = wireToStep(event.step, `step-${items.length}`);
      const index = items.findIndex((item) => item.kind === 'step' && item.step.id === step.id);
      if (index >= 0) items[index] = { kind: 'step', step };
      else items.push({ kind: 'step', step });
      return { ...turn, items };
    }
    case 'done':
    case 'error': {
      // Non-streaming servers send every step only at the end.
      const known = new Set(items.flatMap((item) => (item.kind === 'step' ? [item.step.id] : [])));
      event.steps.forEach((wire, index) => {
        const step = wireToStep(wire, `final-${index}`);
        if (!known.has(step.id)) items.push({ kind: 'step', step });
      });
      const settled: AgentItem[] = items.map((item) =>
        item.kind === 'step' && item.step.status === 'running'
          ? { kind: 'step', step: { ...item.step, status: 'error' } }
          : item
      );
      if (event.type === 'done') {
        const streamed = settled.some((item) => item.kind === 'text' && item.text.trim());
        if (!streamed && event.answer)
          settled.push({ kind: 'text', round: 999, text: event.answer });
        return {
          ...turn,
          items: settled,
          answer: event.answer,
          error: event.answer ? undefined : 'The agent returned no answer.',
          pending: false,
          finishedAt: Date.now(),
        };
      }
      return {
        ...turn,
        items: settled,
        error: event.error,
        pending: false,
        finishedAt: Date.now(),
      };
    }
  }
}

const MAX_HISTORY_TURNS = 14;
const MAX_MESSAGE_CHARS = 8000;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** What the agent did in a turn, so a follow-up knows what is already imported or found. */
const actionDigest = (turn: AgentTurn): string => {
  const lines = turn.items.flatMap((item) => {
    if (item.kind !== 'step') return [];
    const input = JSON.stringify(item.step.input ?? {});
    return [`- ${item.step.tool} ${clip(input, 160)} -> ${clip(stepSummary(item.step), 120)}`];
  });
  return lines.length ? `\n\n[Tools used in this turn]\n${clip(lines.join('\n'), 1500)}` : '';
};

export function buildMessages(turns: AgentTurn[]): AgentMessage[] {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  const messages: AgentMessage[] = [];
  recent.forEach((turn, index) => {
    const isLast = index === recent.length - 1;
    messages.push({ role: 'user', content: clip(turn.user, MAX_MESSAGE_CHARS) });
    if (isLast) return;
    const reply = turn.answer || (turn.error ? `(The previous request failed: ${turn.error})` : '');
    const content = clip(reply, MAX_MESSAGE_CHARS - 1700) + actionDigest(turn);
    messages.push({ role: 'assistant', content: content.trim() || '(no answer)' });
  });
  return messages;
}
