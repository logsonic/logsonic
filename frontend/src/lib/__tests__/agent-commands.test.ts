import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addFilterClause,
  applyAgentCommand,
  removeFilterClauses,
  snapshotUIState,
  splitQuery,
} from '@/lib/agent-commands';
import { useFacetStore } from '@/stores/useFacetStore';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSidebarStore } from '@/stores/useSidebarStore';

vi.mock('@/lib/api-client', () => ({
  getWorkspace: vi.fn(),
}));

const ctx = (route = '/') => {
  const c = { route, navigate: vi.fn((r: string) => (c.route = r)) };
  return c;
};

const run = (type: string, args: Record<string, unknown> = {}, c = ctx()) =>
  applyAgentCommand({ id: 'x', type, args }, c);

beforeEach(() => {
  useSearchQueryParamsStore.getState().resetStore();
  useSearchQueryParamsStore.setState({
    availableColumns: ['timestamp', 'level', 'message', 'status'],
    selectedColumns: ['timestamp', 'message'],
  });
  useFacetStore.setState({ panelOpen: false });
  useLogResultStore.getState().reset();
});

describe('query clause helpers', () => {
  it('adds a filter idempotently and flips polarity', () => {
    let q = addFilterClause('error', 'level', 'warn', false);
    expect(q).toBe('error +level:"warn"');
    expect(addFilterClause(q, 'level', 'warn', false)).toBe(q);
    q = addFilterClause(q, 'level', 'warn', true);
    expect(q).toBe('error -level:"warn"');
  });

  it('keeps numeric values unquoted so numeric fields match', () => {
    const q = addFilterClause('+status:"404"', 'status', '404', false);
    expect(q).toBe('+status:404');
    expect(addFilterClause(q, 'status', '404', true)).toBe('-status:404');
    expect(splitQuery('-bytes:12.5').filters).toEqual([
      { field: 'bytes', value: '12.5', exclude: true },
    ]);
    expect(removeFilterClauses('+status:404 x', 'status', '404')).toBe('x');
  });

  it('removes one value or every clause on a field', () => {
    const q = '+level:"a" -level:"b" +status:"500" timeout';
    expect(removeFilterClauses(q, 'level', 'b')).toBe('+level:"a" +status:"500" timeout');
    expect(removeFilterClauses(q, 'level')).toBe('+status:"500" timeout');
  });

  it('splits filters from free text, unescaping values', () => {
    expect(splitQuery('timeout +msg:"say \\"hi\\"" -host:"a b"')).toEqual({
      filters: [
        { field: 'msg', value: 'say "hi"', exclude: false },
        { field: 'host', value: 'a b', exclude: true },
      ],
      text: 'timeout',
    });
  });
});

describe('applyAgentCommand', () => {
  it('add_filter updates the query, runs a search and goes home', async () => {
    const c = ctx('/import');
    const nonce = useSearchQueryParamsStore.getState().searchNonce;
    const res = await run('add_filter', { field: 'level', value: 'error' }, c);
    const s = useSearchQueryParamsStore.getState();
    expect(s.searchQuery).toBe('+level:"error"');
    expect(s.searchNonce).toBe(nonce + 1);
    expect(res.searched).toBe(true);
    expect(c.navigate).toHaveBeenCalledWith('/');
  });

  it('add_filter warns about a field absent from the results', async () => {
    const res = await run('add_filter', { field: 'nope', value: '1' });
    expect(res.warnings[0]).toMatch(/nope/);
  });

  it('add_filter with run:false does not search', async () => {
    const nonce = useSearchQueryParamsStore.getState().searchNonce;
    const res = await run('add_filter', { field: 'level', value: 'x', run: false });
    expect(useSearchQueryParamsStore.getState().searchNonce).toBe(nonce);
    expect(res.searched).toBe(false);
  });

  it('rejects unfilterable field names', async () => {
    await expect(run('add_filter', { field: 'a b', value: '1' })).rejects.toThrow(
      /cannot be filtered/
    );
  });

  it('clear_filters keeps free text when asked', async () => {
    useSearchQueryParamsStore.setState({ searchQuery: 'timeout +level:"error"' });
    await run('clear_filters', { keep_text: true });
    expect(useSearchQueryParamsStore.getState().searchQuery).toBe('timeout');
    await run('clear_filters');
    expect(useSearchQueryParamsStore.getState().searchQuery).toBe('');
  });

  it('set/show/hide columns keep mandatory columns and warn on unknowns', async () => {
    let res = await run('set_columns', { columns: ['level', 'bogus'] });
    expect(useSearchQueryParamsStore.getState().selectedColumns).toEqual([
      'timestamp',
      'level',
      'bogus',
    ]);
    expect(res.warnings[0]).toMatch(/bogus/);

    await run('show_columns', { columns: 'status,level' });
    expect(useSearchQueryParamsStore.getState().selectedColumns).toEqual([
      'timestamp',
      'level',
      'bogus',
      'status',
    ]);

    res = await run('hide_columns', { columns: ['timestamp', 'bogus'] });
    expect(useSearchQueryParamsStore.getState().selectedColumns).toEqual([
      'timestamp',
      'level',
      'status',
    ]);
    expect(res.warnings[0]).toMatch(/mandatory/);
  });

  it('adding columns to an existing result waits for the refetch', async () => {
    useSearchQueryParamsStore.setState({ hasSearched: true });
    expect((await run('show_columns', { columns: ['status'] })).searched).toBe(true);
    expect((await run('hide_columns', { columns: ['status'] })).searched).toBe(false);
  });

  it('set_time accepts relative presets and absolute ranges', async () => {
    await run('set_time', { relative: 'last-7-days' });
    let s = useSearchQueryParamsStore.getState();
    expect(s.isRelative).toBe(true);
    expect(s.relativeValue).toBe('last-7-days');

    await run('set_time', { start: '2025-01-01T00:00:00Z', end: 1735776000000 });
    s = useSearchQueryParamsStore.getState();
    expect(s.isRelative).toBe(false);
    expect(s.UTCTimeSinceMs).toBe(Date.parse('2025-01-01T00:00:00Z'));
    expect(s.UTCTimeToMs).toBe(1735776000000);

    await expect(run('set_time', { relative: 'last-eon' })).rejects.toThrow(/unknown relative/);
    await expect(run('set_time', { start: 'x', end: 'y' })).rejects.toThrow(/valid/);
  });

  it('set_sort, set_page, set_sources, set_fields_panel', async () => {
    await run('set_sort', { field: 'status', order: 'asc' });
    await run('set_page', { page: 3, page_size: 50 });
    await run('set_sources', { sources: ['nginx'] });
    // Play Home: apply the sidebar request as soon as it is made.
    const unsub = useSidebarStore.subscribe((st) => {
      const req = st.pending;
      if (req) {
        st.clearPending();
        useFacetStore.getState().setPanelOpen(req.panel === 'fields' && req.open);
        st.setCurrent(req.panel, req.open);
      }
    });
    await run('set_sidebar', { panel: 'sources', open: true });
    expect(useSidebarStore.getState().current).toEqual({ panel: 'sources', open: true });
    await run('set_fields_panel', { open: true });
    expect(useSidebarStore.getState().current).toEqual({ panel: 'fields', open: true });
    await expect(run('set_sidebar', { panel: 'nope', open: true })).rejects.toThrow(
      /panel must be/
    );
    unsub();
    const s = useSearchQueryParamsStore.getState();
    expect([s.sortBy, s.sortOrder]).toEqual(['status', 'asc']);
    expect([s.currentPage, s.pageSize]).toEqual([1, 50]);
    expect(s.sources).toEqual(['nginx']);
    expect(useFacetStore.getState().panelOpen).toBe(true);
    await expect(run('set_sort', { order: 'up' })).rejects.toThrow(/asc or desc/);
  });

  it('navigate validates the route', async () => {
    const c = ctx();
    await run('navigate', { route: '/import' }, c);
    expect(c.navigate).toHaveBeenCalledWith('/import');
    await expect(run('navigate', { route: '/nope' })).rejects.toThrow(/unknown route/);
  });

  it('rejects unknown commands', async () => {
    await expect(run('explode')).rejects.toThrow(/unknown ui command/);
  });
});

describe('snapshotUIState', () => {
  it('reports filters, columns and preview rows from the selected columns', () => {
    useSearchQueryParamsStore.setState({ searchQuery: 'oops +level:"error"', resultCount: 7 });
    useLogResultStore.setState({
      logData: { logs: [{ timestamp: 't', message: 'm', hidden: 'h' }] } as never,
    });
    const snap = snapshotUIState('/');
    expect(snap.filters).toEqual([{ field: 'level', value: 'error', exclude: false }]);
    expect(snap.free_text).toBe('oops');
    expect(snap.result_count).toBe(7);
    expect(snap.columns.selected).toEqual(['timestamp', 'message']);
    expect(snap.preview_rows).toEqual([{ timestamp: 't', message: 'm' }]);
  });
});
