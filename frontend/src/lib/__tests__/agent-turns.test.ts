import { describe, expect, it } from 'vitest';

import type { AgentStep, AgentTurn } from '@/stores/useAgentStore';

import { splitSSE } from '@/lib/agent-stream';
import { buildMessages, reduceTurn } from '@/lib/agent-turns';
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
});
