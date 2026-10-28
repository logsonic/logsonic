import type { AgentStep } from '@/stores/useAgentStore';

import { applyAgentCommand, type AgentCommandContext } from '@/lib/agent-commands';

/** The log-table view a tool step looked at, when it can be shown. */
export type StepView = {
  query: string;
  sources: string[];
  start?: string;
  end?: string;
};

const str = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === 'string' ? (input[key] as string).trim() : '';

const sourceList = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const validTime = (value: string) =>
  value && !Number.isNaN(Date.parse(value)) ? value : undefined;

const SEARCH_TOOLS = new Set([
  'query_logs',
  'analyze_logs',
  'facet_logs',
  'log_histogram',
  'log_context',
  'compare_windows',
  'log_patterns',
  'save_view',
]);

/** Imported source names from an ingest step's output. */
const importedSources = (output: unknown): string[] => {
  if (!output || typeof output !== 'object') return [];
  const value = output as Record<string, unknown>;
  const names: string[] = [];
  const collect = (entry: unknown) => {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { source?: unknown }).source === 'string'
    ) {
      names.push((entry as { source: string }).source);
    }
  };
  collect(value);
  collect(value.import);
  if (Array.isArray(value.imports)) value.imports.forEach(collect);
  return names;
};

export const stepView = (step: AgentStep): StepView | null => {
  if (step.status !== 'done') return null;
  const input = step.input || {};
  if (step.tool.startsWith('ingest_')) {
    const sources = importedSources(step.output);
    return sources.length ? { query: '', sources } : null;
  }
  if (!SEARCH_TOOLS.has(step.tool)) return null;
  const view: StepView = {
    query: str(input, 'query'),
    sources: sourceList(str(input, 'source')),
    start: validTime(str(input, 'start_time')),
    end: validTime(str(input, 'end_time')),
  };
  if (step.tool === 'compare_windows') {
    view.start = validTime(str(input, 'incident_start'));
    view.end = validTime(str(input, 'incident_end'));
  }
  if (step.tool === 'log_context') {
    const at = Date.parse(str(input, 'timestamp'));
    if (Number.isNaN(at)) return null;
    const before = Number(input.before_seconds) || 60;
    const after = Number(input.after_seconds) || 60;
    view.start = new Date(at - before * 1000).toISOString();
    view.end = new Date(at + after * 1000).toISOString();
  }
  return view;
};

/** Apply a step's view to the log table through the same commands the agent uses. */
export const applyStepView = async (view: StepView, ctx: AgentCommandContext) => {
  await applyAgentCommand(
    { id: 'view-sources', type: 'set_sources', args: { sources: view.sources, run: false } },
    ctx
  );
  if (view.start && view.end) {
    await applyAgentCommand(
      { id: 'view-time', type: 'set_time', args: { start: view.start, end: view.end, run: false } },
      ctx
    );
  }
  await applyAgentCommand(
    { id: 'view-query', type: 'set_query', args: { query: view.query } },
    ctx
  );
};
