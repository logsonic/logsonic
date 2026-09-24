import { create } from 'zustand';

import type { SavedQuery, Workspace, WorkspaceColorRule } from '@/lib/api-types';
import type { ColorRule } from '@/stores/useColorRuleStore';

import {
  createWorkspace,
  deleteWorkspace as deleteWorkspaceRequest,
  duplicateWorkspace as duplicateWorkspaceRequest,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '@/lib/api-client';
import {
  applyWorkspaceTimeToSearchState,
  normalizeWorkspaceColumnWidths,
  searchStateToWorkspaceTime,
} from '@/lib/workspace-utils';
import { useColorRuleStore } from '@/stores/useColorRuleStore';
import { useSavedQueryDraftStore } from '@/stores/useSavedQueryDraftStore';
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
  savedQueries: SavedQuery[],
  existing?: Workspace
): Workspace => ({
  id: existing?.id,
  name: name.trim(),
  description: description.trim(),
  query: search.searchQuery,
  sources: [...search.sources],
  time: searchStateToWorkspaceTime(search),
  sort_by: search.sortBy,
  sort_order: search.sortOrder === 'asc' ? 'asc' : 'desc',
  columns: [...search.selectedColumns],
  column_widths: normalizeWorkspaceColumnWidths(search.columnWidths),
  color_rules: colorRules.map(toWorkspaceColorRule),
  facet_fields: existing?.facet_fields ? [...existing.facet_fields] : [],
  visualization: existing?.visualization ?? { type: 'logs', bucket: 'auto' },
  favorite: existing?.favorite ?? false,
  saved_queries: [...savedQueries],
  created_at: existing?.created_at,
  updated_at: existing?.updated_at,
});

export const applyWorkspaceToCurrentState = (workspace: Workspace) => {
  const search = useSearchQueryParamsStore.getState();
  const timeState = applyWorkspaceTimeToSearchState(workspace.time, search);

  useSearchQueryParamsStore.setState({
    searchQuery: workspace.query ?? '',
    sources: workspace.sources ?? [],
    sortBy: workspace.sort_by || 'timestamp',
    sortOrder: workspace.sort_order === 'asc' ? 'asc' : 'desc',
    selectedColumns:
      workspace.columns && workspace.columns.length > 0
        ? workspace.columns
        : search.selectedColumns,
    columnWidths: normalizeWorkspaceColumnWidths(workspace.column_widths),
    currentPage: 1,
    ...timeState,
  });

  useColorRuleStore.getState().setRules((workspace.color_rules ?? []).map(toColorRule));
  // A saved query is *loaded into the dropdown*, not auto-run (spec now-03
  // step 6) -- this only replaces the draft's own saved-query list; it must
  // not touch searchQuery/time/sources above.
  useSavedQueryDraftStore.getState().setAll(workspace.saved_queries ?? []);
  useSearchQueryParamsStore.getState().triggerSearch();
};

export const isWorkspaceDirty = (
  workspace: Workspace | undefined,
  search: SearchQueryParamsStoreState,
  colorRules: ColorRule[],
  savedQueries: SavedQuery[]
): boolean => {
  if (!workspace) return false;
  const current = buildWorkspaceFromState(
    workspace.name,
    workspace.description ?? '',
    search,
    colorRules,
    savedQueries,
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
        useColorRuleStore.getState().colorRules,
        useSavedQueryDraftStore.getState().savedQueries
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
        useSavedQueryDraftStore.getState().savedQueries,
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
      const wasActive = get().activeWorkspaceId === id;
      set((state) => ({
        workspaces: state.workspaces.filter((workspace) => workspace.id !== id),
        activeWorkspaceId: wasActive ? null : state.activeWorkspaceId,
        isLoading: false,
      }));
      // Otherwise its saved queries linger in the draft and get silently
      // attached to the next workspace someone saves.
      if (wasActive) useSavedQueryDraftStore.getState().setAll([]);
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
    saved_queries: (workspace.saved_queries ?? []).map((sq) => ({
      id: sq.id,
      name: sq.name,
      query: sq.query ?? '',
      time: sq.time,
      sources: sq.sources ?? [],
      created_at: sq.created_at,
    })),
  };
  return JSON.stringify(normalized);
};
