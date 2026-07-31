import { create } from 'zustand';

import type { Workspace, WorkspaceColorRule } from '@/lib/api-types';
import type { ColorRule } from '@/stores/useColorRuleStore';

import {
  createWorkspace,
  deleteWorkspace as deleteWorkspaceRequest,
  duplicateWorkspace as duplicateWorkspaceRequest,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '@/lib/api-client';
import { calculateRelativeDateRange } from '@/lib/date-utils';
import { useColorRuleStore } from '@/stores/useColorRuleStore';
import {
  SearchQueryParamsStoreState,
  useSearchQueryParamsStore,
} from '@/stores/useSearchQueryParams';

export interface WorkspaceStoreState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isLoading: boolean;
  error: string | null;
  refreshWorkspaces: () => Promise<void>;
  saveCurrentWorkspace: (name: string, description?: string) => Promise<Workspace>;
  updateActiveWorkspace: () => Promise<Workspace>;
  loadWorkspace: (id: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  duplicateWorkspace: (id: string) => Promise<Workspace>;
  toggleFavorite: (id: string) => Promise<Workspace>;
  setActiveWorkspaceId: (id: string | null) => void;
  clearError: () => void;
}

export const buildWorkspaceFromState = (
  name: string,
  description: string,
  search: SearchQueryParamsStoreState,
  colorRules: ColorRule[],
  existing?: Workspace
): Workspace => ({
  id: existing?.id,
  name: name.trim(),
  description: description.trim(),
  query: search.searchQuery,
  sources: [...search.sources],
  time: search.isRelative
    ? search.relativeValue === 'custom'
      ? {
          mode: 'relative',
          relative: search.relativeValue,
          custom_relative_count: search.customRelativeCount,
          custom_relative_unit: search.customRelativeUnit,
        }
      : {
          mode: 'relative',
          relative: search.relativeValue,
        }
    : {
        mode: 'absolute',
        start: search.UTCTimeSince.toISOString(),
        end: search.UTCTimeTo.toISOString(),
      },
  sort_by: search.sortBy,
  sort_order: search.sortOrder === 'asc' ? 'asc' : 'desc',
  columns: [...search.selectedColumns],
  column_widths: { ...search.columnWidths },
  color_rules: colorRules.map(toWorkspaceColorRule),
  facet_fields: existing?.facet_fields ? [...existing.facet_fields] : [],
  visualization: existing?.visualization ?? { type: 'logs', bucket: 'auto' },
  favorite: existing?.favorite ?? false,
  created_at: existing?.created_at,
  updated_at: existing?.updated_at,
});

export const applyWorkspaceToCurrentState = (workspace: Workspace) => {
  const search = useSearchQueryParamsStore.getState();
  const isRelative = workspace.time?.mode !== 'absolute';
  const timeState = isRelative ? relativeTimeState(workspace) : absoluteTimeState(workspace);

  useSearchQueryParamsStore.setState({
    searchQuery: workspace.query ?? '',
    sources: workspace.sources ?? [],
    isRelative,
    relativeValue: workspace.time?.relative || search.relativeValue,
    customRelativeCount: workspace.time?.custom_relative_count || search.customRelativeCount,
    customRelativeUnit: workspace.time?.custom_relative_unit || search.customRelativeUnit,
    sortBy: workspace.sort_by || 'timestamp',
    sortOrder: workspace.sort_order === 'asc' ? 'asc' : 'desc',
    selectedColumns:
      workspace.columns && workspace.columns.length > 0
        ? workspace.columns
        : search.selectedColumns,
    columnWidths: workspace.column_widths ?? {},
    currentPage: 1,
    ...timeState,
  });

  useColorRuleStore.getState().setRules((workspace.color_rules ?? []).map(toColorRule));
  useSearchQueryParamsStore.getState().triggerSearch();
};

export const isWorkspaceDirty = (
  workspace: Workspace | undefined,
  search: SearchQueryParamsStoreState,
  colorRules: ColorRule[]
): boolean => {
  if (!workspace) return false;
  const current = buildWorkspaceFromState(
    workspace.name,
    workspace.description ?? '',
    search,
    colorRules,
    workspace
  );
  return stableWorkspaceSnapshot(current) !== stableWorkspaceSnapshot(workspace);
};

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  isLoading: false,
  error: null,

  refreshWorkspaces: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await listWorkspaces();
      set({ workspaces: response.workspaces ?? [], isLoading: false });
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  saveCurrentWorkspace: async (name, description = '') => {
    set({ isLoading: true, error: null });
    try {
      const workspace = buildWorkspaceFromState(
        name,
        description,
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules
      );
      const response = await createWorkspace(workspace);
      const saved = response.workspace;
      set((state) => ({
        workspaces: upsertWorkspace(state.workspaces, saved),
        activeWorkspaceId: saved.id ?? null,
        isLoading: false,
      }));
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  updateActiveWorkspace: async () => {
    const active = get().workspaces.find((workspace) => workspace.id === get().activeWorkspaceId);
    if (!active?.id) {
      throw new Error('No active workspace');
    }

    set({ isLoading: true, error: null });
    try {
      const workspace = buildWorkspaceFromState(
        active.name,
        active.description ?? '',
        useSearchQueryParamsStore.getState(),
        useColorRuleStore.getState().colorRules,
        active
      );
      const response = await updateWorkspace(active.id, workspace);
      const saved = response.workspace;
      set((state) => ({
        workspaces: upsertWorkspace(state.workspaces, saved),
        activeWorkspaceId: saved.id ?? active.id,
        isLoading: false,
      }));
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  loadWorkspace: async (id) => {
    set({ isLoading: true, error: null });
    try {
      let workspace = get().workspaces.find((item) => item.id === id);
      if (!workspace) {
        const response = await getWorkspace(id);
        workspace = response.workspace;
      }
      applyWorkspaceToCurrentState(workspace);
      set((state) => ({
        workspaces: upsertWorkspace(state.workspaces, workspace),
        activeWorkspaceId: workspace?.id ?? id,
        isLoading: false,
      }));
      return workspace;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  deleteWorkspace: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteWorkspaceRequest(id);
      set((state) => ({
        workspaces: state.workspaces.filter((workspace) => workspace.id !== id),
        activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
        isLoading: false,
      }));
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  duplicateWorkspace: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const response = await duplicateWorkspaceRequest(id);
      const workspace = response.workspace;
      set((state) => ({
        workspaces: upsertWorkspace(state.workspaces, workspace),
        activeWorkspaceId: workspace.id ?? null,
        isLoading: false,
      }));
      return workspace;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  toggleFavorite: async (id) => {
    const workspace = get().workspaces.find((item) => item.id === id);
    if (!workspace?.id) {
      throw new Error('Workspace not found');
    }

    set({ isLoading: true, error: null });
    try {
      const response = await updateWorkspace(workspace.id, {
        ...workspace,
        favorite: !workspace.favorite,
      });
      const saved = response.workspace;
      set((state) => ({
        workspaces: upsertWorkspace(state.workspaces, saved),
        isLoading: false,
      }));
      return saved;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
  clearError: () => set({ error: null }),
}));

const relativeTimeState = (workspace: Workspace) => {
  const search = useSearchQueryParamsStore.getState();
  const relativeValue = workspace.time?.relative || search.relativeValue;
  const unit = workspace.time?.custom_relative_unit || search.customRelativeUnit;
  const count = workspace.time?.custom_relative_count || search.customRelativeCount;
  const { startDate, endDate } = calculateRelativeDateRange(relativeValue, unit, count);
  return {
    UTCTimeSince: startDate,
    UTCTimeTo: endDate,
    UTCTimeSinceMs: startDate.getTime(),
    UTCTimeToMs: endDate.getTime(),
  };
};

const absoluteTimeState = (workspace: Workspace) => {
  const start = workspace.time?.start
    ? new Date(workspace.time.start)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = workspace.time?.end ? new Date(workspace.time.end) : new Date();
  const safeStart = Number.isNaN(start.getTime())
    ? new Date(Date.now() - 24 * 60 * 60 * 1000)
    : start;
  const safeEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  return {
    UTCTimeSince: safeStart,
    UTCTimeTo: safeEnd,
    UTCTimeSinceMs: safeStart.getTime(),
    UTCTimeToMs: safeEnd.getTime(),
  };
};

const toWorkspaceColorRule = (rule: ColorRule): WorkspaceColorRule => ({
  id: rule.id,
  field: rule.field,
  operator: rule.operator,
  value: rule.value,
  color: rule.color,
  enabled: rule.enabled,
});

const toColorRule = (rule: WorkspaceColorRule): ColorRule => ({
  id: rule.id || crypto.randomUUID(),
  field: rule.field,
  operator: rule.operator,
  value: rule.value,
  color: rule.color,
  enabled: rule.enabled,
});

const upsertWorkspace = (items: Workspace[], workspace: Workspace): Workspace[] => {
  const exists = items.some((item) => item.id === workspace.id);
  const next = exists
    ? items.map((item) => (item.id === workspace.id ? workspace : item))
    : [...items, workspace];
  return [...next].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
  });
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Workspace request failed';

const stableWorkspaceSnapshot = (workspace: Workspace): string => {
  const normalized = {
    name: workspace.name,
    description: workspace.description ?? '',
    query: workspace.query ?? '',
    sources: workspace.sources ?? [],
    time: workspace.time,
    sort_by: workspace.sort_by ?? 'timestamp',
    sort_order: workspace.sort_order ?? 'desc',
    columns: workspace.columns ?? [],
    column_widths: Object.fromEntries(
      Object.entries(workspace.column_widths ?? {}).sort(([a], [b]) => a.localeCompare(b))
    ),
    color_rules: (workspace.color_rules ?? []).map((rule) => ({
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      color: rule.color,
      enabled: rule.enabled,
    })),
    facet_fields: workspace.facet_fields ?? [],
    visualization: workspace.visualization ?? { type: 'logs', bucket: 'auto' },
    favorite: !!workspace.favorite,
  };
  return JSON.stringify(normalized);
};
