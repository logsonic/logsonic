import { describe, expect, it } from 'vitest';

import type { AgentStep, AgentTurn } from '@/stores/useAgentStore';

import { parseAgentEvent, splitSSE } from '@/lib/agent-stream';
import { buildMessages, reduceTurn, stepSummary, toolLabel } from '@/lib/agent-turns';
import { stepView } from '@/lib/agent-view';

const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({
  user: 'q',
  items: [],
  pending: true,
  startedAt: 0,
  ...over,
});

describe('splitSSE', () => {
  it('keeps a partial event as the unconsumed tail and skips comments', () => {
    const { events, rest } = splitSSE(
      ': ping\n\nevent: text\ndata: {"a":1}\n\nevent: done\ndata: {'
    );
    expect(events).toEqual([['text', '{"a":1}']]);
    expect(rest).toBe('event: done\ndata: {');
  });
});

describe('parseAgentEvent', () => {
  it('parses an approval request with its exact tool arguments', () => {
    expect(
      parseAgentEvent(
        'approval_required',
        JSON.stringify({
          id: 'capability-1',
          tool: 'mcp__remote__write',
          input: { path: '/tmp/a', content: '<secret>' },
          reason: 'Writes a file',
        })
      )
    ).toEqual({
      type: 'approval_required',
      id: 'capability-1',
      tool: 'mcp__remote__write',
      input: { path: '/tmp/a', content: '<secret>' },
      reason: 'Writes a file',
    });
  });

  it('rejects incomplete approval requests', () => {
    expect(
      parseAgentEvent('approval_required', '{"tool":"mcp__remote__write","input":{}}')
    ).toBeNull();
  });
});

describe('reduceTurn', () => {
  it('merges text deltas within a round and starts a new item for a new round', () => {
    let t = reduceTurn(turn(), { type: 'text', round: 1, delta: 'Hel' });
    t = reduceTurn(t, { type: 'text', round: 1, delta: 'lo' });
    t = reduceTurn(t, { type: 'step_start', id: 's', tool: 'query_logs', input: {} });
    t = reduceTurn(t, { type: 'text', round: 2, delta: 'Done' });
    expect(t.items.map((item) => (item.kind === 'text' ? item.text : item.step.tool))).toEqual([
      'Hello',
      'query_logs',
      'Done',
    ]);
  });

  it('replaces a running step with its result and marks tool errors', () => {
    let t = reduceTurn(turn(), { type: 'step_start', id: 's', tool: 'query_logs', input: {} });
    t = reduceTurn(t, {
      type: 'step',
      step: {
        id: 's',
        tool: 'query_logs',
        input: {},
        output: { error: 'bad query' },
        is_error: true,
      },
    });
    expect(t.items).toHaveLength(1);
    expect(t.items[0].kind === 'step' && t.items[0].step.status).toBe('error');
  });

  it('adds the answer as text when nothing was streamed', () => {
    const t = reduceTurn(turn(), { type: 'done', answer: 'All good', steps: [] });
    expect(t.pending).toBe(false);
    expect(t.items).toEqual([{ kind: 'text', round: 999, text: 'All good' }]);
  });
});

describe('buildMessages', () => {
  it('limits history and ends with the pending user turn', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      turn({ user: `q${i}`, answer: `a${i}`, pending: false })
    );
    turns.push(turn({ user: 'latest' }));
    const messages = buildMessages(turns);
    expect(messages.length).toBeLessThanOrEqual(40);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'latest' });
    expect(messages[0].role).toBe('user');
  });
});

describe('stepView', () => {
  const step = (over: Partial<AgentStep>): AgentStep => ({
    id: 'x',
    tool: 'query_logs',
    input: {},
    status: 'done',
    ...over,
  });

  it('maps search tools to query, sources and time', () => {
    expect(
      stepView(
        step({
          input: {
            query: 'level:error',
            source: 'a.log, b.log',
            start_time: '2026-10-28T10:00:00Z',
            end_time: '2026-10-28T11:00:00Z',
          },
        })
      )
    ).toEqual({
      query: 'level:error',
      sources: ['a.log', 'b.log'],
      start: '2026-10-28T10:00:00Z',
      end: '2026-10-28T11:00:00Z',
    });
  });

  it('centers log_context on its timestamp', () => {
    const view = stepView(
      step({
        tool: 'log_context',
        input: { timestamp: '2026-10-28T10:18:00Z', before_seconds: 30, after_seconds: 90 },
      })
    );
    expect(view?.start).toBe('2026-10-28T10:17:30.000Z');
    expect(view?.end).toBe('2026-10-28T10:19:30.000Z');
  });

  it('shows the sources an import created and nothing for running or UI steps', () => {
    expect(
      stepView(
        step({
          tool: 'ingest_local',
          output: { imports: [{ source: 'a.jsonl' }, { source: 'b.jsonl' }] },
        })
      )
    ).toEqual({ query: '', sources: ['a.jsonl', 'b.jsonl'] });
    expect(stepView(step({ status: 'running' }))).toBeNull();
    expect(stepView(step({ tool: 'ui_show_view' }))).toBeNull();
  });

  it('shows the window a saved view or pattern scan covered', () => {
    const input = {
      query: 'psp_code:invalid_amount',
      source: 'payments.jsonl',
      start_time: '2026-10-27T11:32:00Z',
      end_time: '2026-10-27T18:00:00Z',
    };
    const expected = {
      query: 'psp_code:invalid_amount',
      sources: ['payments.jsonl'],
      start: '2026-10-27T11:32:00Z',
      end: '2026-10-27T18:00:00Z',
    };
    expect(stepView(step({ tool: 'save_view', input }))).toEqual(expected);
    expect(stepView(step({ tool: 'log_patterns', input }))).toEqual(expected);
  });
});

describe('stepSummary for full-scan tools', () => {
  it('summarizes pattern scans and saved views', () => {
    const done = (tool: string, output: unknown): AgentStep => ({
      id: 'x',
      tool,
      input: {},
      output,
      status: 'done',
    });
    expect(
      stepSummary(
        done('log_patterns', { scanned: 188864, distinct_patterns: 51, total_count: 188864 })
      )
    ).toBe('51 patterns in 188,864 events');
    expect(
      stepSummary(done('save_view', { id: 'w1', name: 'JPY declines', matching_rows: 324 }))
    ).toBe('Saved “JPY declines” (324 events)');
  });
});

describe('external MCP tools', () => {
  it('labels them by server and tool and summarizes their text', () => {
    expect(toolLabel('mcp__tickets__search_issues')).toBe('tickets · search_issues');
    expect(toolLabel('mcp__my-fs__read_file')).toBe('my-fs · read_file');
    expect(toolLabel('query_logs')).toBe('Search logs');
    const step: AgentStep = {
      id: 'x',
      tool: 'mcp__tickets__search_issues',
      input: {},
      output: { server: 'tickets', tool: 'search_issues', text: '\nINC-42: checkout outage\nmore' },
      status: 'done',
    };
    expect(stepSummary(step)).toBe('INC-42: checkout outage');
  });
});
