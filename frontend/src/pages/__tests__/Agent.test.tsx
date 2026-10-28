import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Agent from '../Agent';

import { useAgentStore } from '@/stores/useAgentStore';

const json = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => value,
  }) as Response;

/** A text/event-stream response that emits the given events, then closes. */
const sse = (events: Array<[string, unknown]>) => {
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        // Split one event across chunks to exercise buffering.
        const all = body.join('');
        controller.enqueue(encoder.encode(all.slice(0, 25)));
        controller.enqueue(encoder.encode(all.slice(25)));
        controller.close();
      },
    }),
  } as unknown as Response;
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <Agent />
    </MemoryRouter>
  );

const ask = (text: string) => {
  fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
};

beforeEach(() => {
  localStorage.clear();
  useAgentStore.setState({ sessions: [], activeId: null, viewStepId: null });
  vi.stubGlobal('fetch', vi.fn());
});

describe('Agent', () => {
  it('streams steps and text, then sends history with a digest of the tools used', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ available: true, model: 'local-model' }))
      .mockResolvedValueOnce(
        sse([
          ['step_start', { id: 't1', tool: 'query_logs', input: { query: 'level:error' } }],
          [
            'step',
            {
              id: 't1',
              tool: 'query_logs',
              input: { query: 'level:error' },
              output: { total_count: 3, logs: [] },
            },
          ],
          ['text', { round: 1, delta: 'Found 3 ' }],
          ['text', { round: 1, delta: 'errors.' }],
          ['done', { answer: 'Found 3 errors.', steps: [] }],
        ])
      )
      // The dock reloads its status after each turn.
      .mockResolvedValueOnce(json({ available: true, model: 'local-model' }))
      .mockResolvedValueOnce(sse([['done', { answer: 'Two are from auth.', steps: [] }]]))
      .mockResolvedValueOnce(json({ available: true, model: 'local-model' }));
    renderPage();
    await screen.findByText('local-model');
    ask('Find errors');
    await screen.findByText('Found 3 errors.');
    expect(screen.getByText('Search logs')).toBeTruthy();
    expect(screen.getByText('3 matching events')).toBeTruthy();
    fireEvent.click(screen.getByText('Search logs').closest('summary')!);
    expect(screen.getByText(/"total_count": 3/)).toBeTruthy();

    ask('Which service?');
    await screen.findByText('Two are from auth.');
    const body = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toContain('Found 3 errors.');
    expect(body.messages[1].content).toContain('query_logs');
    expect(body.messages[2]).toEqual({ role: 'user', content: 'Which service?' });
  });

  it('shows unavailable status and disables requests', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ available: false, reason: 'Configure a model.' })
    );
    renderPage();
    await screen.findByText('Unavailable');
    expect(screen.getByText('Configure a model.')).toBeTruthy();
    expect((screen.getByLabelText('Message the agent') as HTMLTextAreaElement).disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps completed steps when the stream ends in an error', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ available: true }))
      .mockResolvedValueOnce(
        sse([
          ['step_start', { id: 'a', tool: 'facet_logs', input: {} }],
          ['step', { id: 'a', tool: 'facet_logs', input: {}, output: { fields: [{}, {}] } }],
          ['step_start', { id: 'b', tool: 'log_histogram', input: {} }],
          ['error', { error: 'agent tool limit reached', steps: [] }],
        ])
      );
    const { container } = renderPage();
    await screen.findByText('Ready');
    ask('Inspect warnings');
    await screen.findByText('agent tool limit reached');
    expect(screen.getByText('2 fields broken down')).toBeTruthy();
    // The step still running when the stream failed is settled as failed.
    expect(container.querySelector('.ls-step.is-running')).toBeNull();
    expect(container.querySelectorAll('.ls-step.is-error')).toHaveLength(1);
  });

  it('accepts a plain JSON reply from an older backend and labels UI tools by task', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ available: true }))
      .mockResolvedValueOnce(
        json({
          answer: 'The view shows six events.',
          steps: [
            {
              id: 'u1',
              tool: 'ui_show_view',
              input: { query: 'level:ERROR' },
              output: { status: 'applied', state: { result_count: 6 } },
            },
          ],
        })
      );
    renderPage();
    await screen.findByText('Ready');
    ask('Show errors');
    await screen.findByText('The view shows six events.');
    expect(screen.getByText('Update the log view')).toBeTruthy();
    expect(screen.getByText('6 matching events on screen')).toBeTruthy();
    expect(screen.queryByText('Ui show view')).toBeNull();
  });

  it('renders markdown safely', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ available: true }))
      .mockResolvedValueOnce(
        sse([
          [
            'done',
            {
              answer:
                '## Findings\n\n- **Auth** failed\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
              steps: [],
            },
          ],
        ])
      );
    const { container } = renderPage();
    await screen.findByText('Ready');
    ask('Summarize');
    await screen.findByRole('heading', { name: 'Findings' });
    expect(screen.getByText('Auth').tagName).toBe('STRONG');
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('href="javascript:');
  });

  it('stops a running request and permits retry', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    fetchMock.mockResolvedValueOnce(sse([['done', { answer: 'Completed on retry.', steps: [] }]]));
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    renderPage();
    await screen.findByText('Ready');
    ask('Inspect logs');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Stopped.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Completed on retry.');
    // Status, stopped request, status, retry, status.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
  });

  it('keeps past investigations and reopens them from history', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ available: true }))
      .mockResolvedValueOnce(sse([['done', { answer: 'First answer.', steps: [] }]]));
    renderPage();
    await screen.findByText('Ready');
    ask('First question');
    await screen.findByText('First answer.');
    fireEvent.click(screen.getByRole('button', { name: 'New investigation' }));
    expect(screen.getByRole('heading', { name: 'Ask about your logs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Past investigations' }));
    fireEvent.click(screen.getByText('First question'));
    expect(screen.getByText('First answer.')).toBeTruthy();
    const persisted = JSON.parse(localStorage.getItem('logsonic-agent') || '{}');
    expect(persisted.state.sessions[0].turns[0].answer).toBe('First answer.');
  });

  it('refreshes workspaces when save_view succeeds and shows remote endpoint note', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const { useWorkspaceStore } = await import('@/stores/useWorkspaceStore');
    useWorkspaceStore.setState({ refreshWorkspaces: refreshSpy });

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        json({
          available: true,
          model: 'claude-sonnet-5-5',
          proxy_url: 'https://api.anthropic.com/v1/messages',
        })
      )
      .mockResolvedValueOnce(
        sse([
          [
            'step',
            {
              id: 'sv1',
              tool: 'save_view',
              input: { name: 'Checkout Spike' },
              output: { id: 'ws-1', name: 'Checkout Spike', matching_rows: 12 },
              is_error: false,
            },
          ],
          ['done', { answer: 'Saved view.', steps: [] }],
        ])
      )
      .mockResolvedValueOnce(
        json({
          available: true,
          model: 'claude-sonnet-5-5',
          proxy_url: 'https://api.anthropic.com/v1/messages',
        })
      );

    renderPage();
    await screen.findByText('claude-sonnet-5-5');
    expect(
      screen.getByText(
        'Log excerpts the agent reads are sent to the configured model endpoint (api.anthropic.com).'
      )
    ).toBeTruthy();

    ask('Save this view');
    await screen.findByText('Saved view.');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
