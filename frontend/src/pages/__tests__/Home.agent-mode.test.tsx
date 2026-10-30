import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Home from '../Home';

import { useAgentStore } from '@/stores/useAgentStore';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/components/Home/Header', () => ({ Header: () => <div>Top bar</div> }));
vi.mock('@/components/Home/LogSearch', () => ({
  LogSearch: () => {
    const [value, setValue] = useState('');
    return (
      <input
        aria-label="Mock search draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));
vi.mock('@/components/Home/LogViewer/LogViewer', () => ({ LogViewer: () => <div>Log table</div> }));
vi.mock('@/components/Home/Sidebar/CollapsiblePanel', () => ({
  LeftPanelContent: () => null,
  SIDEBAR_WIDTHS: { EXPANDED: 320 },
}));
vi.mock('@/components/Home/SidebarPanel', () => ({ SidebarPanel: () => ({ tabs: [] }) }));
vi.mock('@/components/Shell/LeftRail', () => ({ LeftRail: () => <div>Navigation rail</div> }));
vi.mock('@/components/Shell/StatusBar', () => ({ StatusBar: () => <div>Status bar</div> }));
vi.mock('@/lib/native', () => ({ isNativeShell: () => false }));
vi.mock('@/stores/useFacetStore', () => ({
  useFacetStore: (selector: (state: { setPanelOpen: () => void }) => unknown) =>
    selector({ setPanelOpen: vi.fn() }),
}));
vi.mock('@/stores/useLogResultStore', () => ({
  useLogResultStore: (selector: (state: { logData: null }) => unknown) =>
    selector({ logData: null }),
}));
vi.mock('@/stores/useSearchQueryParams', () => ({
  default: () => ({ firstLoad: false, setFirstLoad: vi.fn(), triggerSearch: refresh }),
}));
vi.mock('@/stores/useSidebarStore', () => {
  const useSidebarStore = (selector: (state: { pending: null }) => unknown) =>
    selector({ pending: null });
  useSidebarStore.getState = () => ({ setCurrent: vi.fn() });
  return { useSidebarStore };
});

beforeEach(() => {
  refresh.mockClear();
  localStorage.clear();
  useAgentStore.setState({ panelOpen: false, sessions: [], activeId: null });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ available: true, model: 'test-model' }),
    })
  );
});

const renderHome = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Home />}>
          <Route index element={null} />
          <Route path="agent" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

describe('Home agent dock', () => {
  it('opens beside the log table with Cmd+J and keeps the search draft', async () => {
    renderHome();
    fireEvent.change(screen.getByLabelText('Mock search draft'), {
      target: { value: 'level:error' },
    });
    expect(screen.queryByLabelText('Agent panel')).toBeNull();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(await screen.findByLabelText('Agent panel')).toBeTruthy();
    expect(screen.getByText('Log table')).toBeTruthy();
    expect((screen.getByLabelText('Mock search draft') as HTMLInputElement).value).toBe(
      'level:error'
    );
    await screen.findByText('test-model');
    fireEvent.click(screen.getByRole('button', { name: 'Close agent' }));
    expect(screen.queryByLabelText('Agent panel')).toBeNull();
    expect(useAgentStore.getState().panelOpen).toBe(false);
  });

  it('treats the legacy #/agent route as a link that opens the dock', async () => {
    renderHome('/agent');
    expect(await screen.findByLabelText('Agent panel')).toBeTruthy();
    expect(useAgentStore.getState().panelOpen).toBe(true);
  });
});
