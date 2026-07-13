import { beforeEach, describe, expect, it } from 'vitest';

import { useSearchQueryParamsStore } from '../useSearchQueryParams';

import type { Workspace } from '@/lib/api-types';

import { useColorRuleStore } from '@/stores/useColorRuleStore';
import {
  applyWorkspaceToCurrentState,
  buildWorkspaceFromState,
  isWorkspaceDirty,
} from '@/stores/useWorkspaceStore';

beforeEach(() => {
  useSearchQueryParamsStore.getState().resetStore();
  useColorRuleStore.getState().clearRules();
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
      useColorRuleStore.getState().colorRules
    );

    expect(workspace.name).toBe('Production 5xx');
    expect(workspace.query).toBe('+status:>=500');
    expect(workspace.sources).toEqual(['nginx.log']);
    expect(workspace.time).toMatchObject({ mode: 'relative', relative: 'last-7-days' });
    expect(workspace.columns).toEqual(['timestamp', 'status', 'url']);
    expect(workspace.column_widths).toEqual({ status: 96, url: 360 });
    expect(workspace.color_rules).toHaveLength(1);
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
        useColorRuleStore.getState().colorRules
      )
    ).toBe(false);

    useSearchQueryParamsStore.getState().setSearchQuery('error timeout');
    expect(
      isWorkspaceDirty(
        workspace,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules
      )
    ).toBe(true);
  });
});
