import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearchQueryParamsStore } from '../useSearchQueryParams';

import type { Workspace } from '@/lib/api-types';

import { deleteWorkspace as deleteWorkspaceRequest } from '@/lib/api-client';
import { useColorRuleStore } from '@/stores/useColorRuleStore';
import { useSavedQueryDraftStore } from '@/stores/useSavedQueryDraftStore';
import {
  applyWorkspaceToCurrentState,
  buildWorkspaceFromState,
  isWorkspaceDirty,
  useWorkspaceStore,
} from '@/stores/useWorkspaceStore';

vi.mock('@/lib/api-client', () => ({
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  useSearchQueryParamsStore.getState().resetStore();
  useColorRuleStore.getState().clearRules();
  useSavedQueryDraftStore.getState().setAll([]);
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    error: null,
    isLoading: false,
  });
  vi.mocked(deleteWorkspaceRequest).mockClear();
});

describe('workspace state mapping', () => {
  it('builds a workspace from the current search and color state', () => {
    const search = useSearchQueryParamsStore.getState();
    search.setSearchQuery('+status:>=500');
    search.setSources(['nginx.log']);
    search.setRelativeValue('last-7-days');
    search.setSelectedColumns(['timestamp', 'status', 'url']);
    search.setColumnWidths({ status: 96, url: 360 });
    useColorRuleStore.getState().setRules([
      {
        id: 'rule-1',
        field: 'status',
        operator: 'eq',
        value: '500',
        color: 'bg-red-100',
        enabled: true,
      },
    ]);

    const workspace = buildWorkspaceFromState(
      'Production 5xx',
      'HTTP failures',
      useSearchQueryParamsStore.getState(),
      useColorRuleStore.getState().colorRules,
      []
    );

    expect(workspace.name).toBe('Production 5xx');
    expect(workspace.query).toBe('+status:>=500');
    expect(workspace.sources).toEqual(['nginx.log']);
    expect(workspace.time).toMatchObject({ mode: 'relative', relative: 'last-7-days' });
    expect(workspace.columns).toEqual(['timestamp', 'status', 'url']);
    expect(workspace.column_widths).toEqual({ status: 96, url: 360 });
    expect(workspace.color_rules).toHaveLength(1);
  });

  it('clamps oversized persisted column widths before saving', () => {
    const search = useSearchQueryParamsStore.getState();
    search.setSelectedColumns(['timestamp', 'program']);
    // Hydrated Zustand state can predate the normalization boundary.
    useSearchQueryParamsStore.setState({ columnWidths: { program: 2400 } });

    const workspace = buildWorkspaceFromState(
      'Program view',
      '',
      useSearchQueryParamsStore.getState(),
      useColorRuleStore.getState().colorRules,
      []
    );

    expect(workspace.column_widths).toEqual({ program: 2000 });
  });

  it('applies a workspace to search state and color rules', () => {
    const workspace: Workspace = {
      id: 'workspace-1',
      name: 'API errors',
      query: '+level:ERROR',
      sources: ['api.log'],
      time: {
        mode: 'absolute',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z',
      },
      sort_by: 'timestamp',
      sort_order: 'asc',
      columns: ['timestamp', 'level', 'message'],
      column_widths: { message: 420 },
      color_rules: [
        {
          id: 'rule-1',
          field: 'level',
          operator: 'eq',
          value: 'ERROR',
          color: 'bg-red-100',
          enabled: true,
        },
      ],
      visualization: { type: 'logs', bucket: 'auto' },
    };

    applyWorkspaceToCurrentState(workspace);

    const search = useSearchQueryParamsStore.getState();
    expect(search.searchQuery).toBe('+level:ERROR');
    expect(search.sources).toEqual(['api.log']);
    expect(search.isRelative).toBe(false);
    expect(search.UTCTimeSince.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(search.UTCTimeTo.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(search.sortOrder).toBe('asc');
    expect(search.selectedColumns).toEqual(['timestamp', 'level', 'message']);
    expect(search.columnWidths).toEqual({ message: 420 });
    expect(useColorRuleStore.getState().colorRules[0].field).toBe('level');
    expect(search.hasSearched).toBe(true);
  });

  // F7
  it('loads saved queries into the draft without auto-running any of them', () => {
    const triggerSearchSpy = vi.spyOn(useSearchQueryParamsStore.getState(), 'triggerSearch');
    const workspace: Workspace = {
      id: 'workspace-3',
      name: 'API errors',
      query: '+level:ERROR',
      sources: [],
      time: { mode: 'relative', relative: 'last-24-hours' },
      sort_by: 'timestamp',
      sort_order: 'desc',
      columns: [],
      column_widths: {},
      color_rules: [],
      visualization: { type: 'logs', bucket: 'auto' },
      saved_queries: [
        { id: 'sq-1', name: 'Timeouts', query: 'timeout', created_at: '2026-01-01T00:00:00Z' },
        { id: 'sq-2', name: '5xx', query: 'status:>=500', created_at: '2026-01-01T00:05:00Z' },
      ],
    };

    applyWorkspaceToCurrentState(workspace);

    // The workspace's own query is what runs -- not either saved query --
    // and the search-trigger action fires exactly once, for that one query.
    expect(useSearchQueryParamsStore.getState().searchQuery).toBe('+level:ERROR');
    expect(triggerSearchSpy).toHaveBeenCalledTimes(1);
    expect(useSavedQueryDraftStore.getState().savedQueries).toHaveLength(2);
    expect(useSavedQueryDraftStore.getState().savedQueries.map((sq) => sq.name)).toEqual([
      'Timeouts',
      '5xx',
    ]);

    triggerSearchSpy.mockRestore();
  });

  it('detects divergence from the active workspace', () => {
    const workspace: Workspace = {
      id: 'workspace-1',
      name: 'Saved',
      query: 'error',
      sources: [],
      time: { mode: 'relative', relative: 'last-24-hours' },
      sort_by: 'timestamp',
      sort_order: 'desc',
      columns: [],
      column_widths: {},
      color_rules: [],
      visualization: { type: 'logs', bucket: 'auto' },
      favorite: false,
    };

    applyWorkspaceToCurrentState(workspace);
    expect(
      isWorkspaceDirty(
        workspace,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules,
        useSavedQueryDraftStore.getState().savedQueries
      )
    ).toBe(false);

    useSearchQueryParamsStore.getState().setSearchQuery('error timeout');
    expect(
      isWorkspaceDirty(
        workspace,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules,
        useSavedQueryDraftStore.getState().savedQueries
      )
    ).toBe(true);
  });

  // F8
  it('is dirty after adding a saved query, even with no other changes', () => {
    const workspace: Workspace = {
      id: 'workspace-2',
      name: 'Saved',
      query: 'error',
      sources: [],
      time: { mode: 'relative', relative: 'last-24-hours' },
      sort_by: 'timestamp',
      sort_order: 'desc',
      columns: [],
      column_widths: {},
      color_rules: [],
      visualization: { type: 'logs', bucket: 'auto' },
      favorite: false,
      saved_queries: [],
    };

    applyWorkspaceToCurrentState(workspace);
    expect(
      isWorkspaceDirty(
        workspace,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules,
        useSavedQueryDraftStore.getState().savedQueries
      )
    ).toBe(false);

    useSavedQueryDraftStore.getState().addSavedQuery({ name: 'Errors', query: 'error' });
    expect(
      isWorkspaceDirty(
        workspace,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules,
        useSavedQueryDraftStore.getState().savedQueries
      )
    ).toBe(true);
  });
});

describe('deleteWorkspace', () => {
  const minimalWorkspace = (id: string): Workspace => ({
    id,
    name: id,
    query: '',
    sources: [],
    time: { mode: 'relative', relative: 'last-24-hours' },
    sort_by: 'timestamp',
    sort_order: 'desc',
    columns: [],
    column_widths: {},
    color_rules: [],
    visualization: { type: 'logs', bucket: 'auto' },
    favorite: false,
    saved_queries: [],
  });

  it('clears the saved-query draft when the deleted workspace was active', async () => {
    useWorkspaceStore.setState({
      workspaces: [minimalWorkspace('w1')],
      activeWorkspaceId: 'w1',
    });
    useSavedQueryDraftStore.getState().addSavedQuery({ name: 'Errors', query: 'error' });
    expect(useSavedQueryDraftStore.getState().savedQueries).toHaveLength(1);

    await useWorkspaceStore.getState().deleteWorkspace('w1');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(useSavedQueryDraftStore.getState().savedQueries).toEqual([]);
  });

  it('leaves the saved-query draft untouched when the deleted workspace was not active', async () => {
    useWorkspaceStore.setState({
      workspaces: [minimalWorkspace('w1'), minimalWorkspace('w2')],
      activeWorkspaceId: 'w1',
    });
    useSavedQueryDraftStore.getState().addSavedQuery({ name: 'Errors', query: 'error' });

    await useWorkspaceStore.getState().deleteWorkspace('w2');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('w1');
    expect(useSavedQueryDraftStore.getState().savedQueries).toHaveLength(1);
  });
});
