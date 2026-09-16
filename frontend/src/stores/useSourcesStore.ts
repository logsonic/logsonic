import { create } from 'zustand';

import type { SourceEntry } from '@/lib/api-types';

import { waitForIngestJob } from '@/components/Import/hooks/ingestJobEvents';
import { refreshSearchMetadata } from '@/hooks/useSearchLogs';
import {
  ApiError,
  deleteSource as deleteSourceRequest,
  getSystemInfo,
  listSources,
  reimportSource as reimportSourceRequest,
  renameSource as renameSourceRequest,
} from '@/lib/api-client';
import { useFacetStore } from '@/stores/useFacetStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

/**
 * A re-import in flight. The server keeps the catalog entry at zero rows
 * while the job refills it, so the row stays in the list and shows this
 * state; if the entry is ever absent (an older server that deleted it), the
 * panel renders a synthetic row from this instead. A page reload loses the
 * in-flight state: the job itself carries no source name.
 */
export interface ReimportInFlight {
  name: string;
  jobId: string;
  path: string;
  rowsStored: number;
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

interface SourcesState {
  sources: SourceEntry[];
  isLoading: boolean;
  /** Set once the first fetch has settled, so "no sources" isn't shown before it. */
  loaded: boolean;
  error: string | null;
  expanded: string | null;
  /** Names with a delete in progress; their actions are disabled and the row stays visible. */
  deleting: Set<string>;
  reimports: Record<string, ReimportInFlight>;

  fetchSources: () => Promise<void>;
  setExpanded: (name: string | null) => void;
  deleteSource: (name: string) => Promise<{ rowsDeleted: number }>;
  renameSource: (name: string, displayName: string) => Promise<SourceEntry>;
  reimportSource: (name: string) => Promise<void>;
  clearReimport: (name: string) => void;
}

/** User copy for the failures a source action can hit; anything else falls back to the server's message. */
export const sourceErrorMessage = (err: unknown, fallback: string): string => {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'SOURCE_IN_USE':
        return err.details?.includes('live tail')
          ? 'A live tail is still writing to this source. Stop it first.'
          : 'An import is still running for this source. Wait for it to finish.';
      case 'SOURCE_NOT_REIMPORTABLE':
        return 'This source was uploaded from the browser, so there is no file to re-import from.';
      case 'SOURCE_NAME_TAKEN':
        return 'Another source already uses that name.';
      case 'SOURCE_NAME_INVALID':
        return 'Use 1–120 characters with no leading or trailing spaces.';
      case 'INVALID_PATH':
        return 'The original file is no longer readable at its recorded path. Nothing was deleted.';
      case 'SOURCE_NOT_FOUND':
        return 'That source no longer exists.';
    }
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
};

/**
 * Every other surface that lists sources — the Filter tab, SourceTabs, the
 * status bar count — reads /info, and the Fields panel's _src facet comes
 * from the catalog on the next metadata request. Neither refetches on its
 * own after a mutation (the facet's fingerprint tracks the query, not the
 * data), so this pushes both, and re-runs the search so the table drops
 * rows that just went away even when that source wasn't selected.
 */
const refreshAfterMutation = async () => {
  try {
    const info = await getSystemInfo(true);
    useSystemInfoStore.getState().setSystemInfo(info);
  } catch {
    // The panel's own list is authoritative for what it shows; a failed
    // /info refresh only delays the other surfaces until their next fetch.
  }
  const facets = useFacetStore.getState();
  if (facets.panelOpen) {
    void refreshSearchMetadata({ includeFacets: true });
  } else {
    facets.setFacets(null, null);
  }
  const search = useSearchQueryParamsStore.getState();
  search.resetPagination();
  search.triggerSearch();
};

export const useSourcesStore = create<SourcesState>((set, get) => ({
  sources: [],
  isLoading: false,
  loaded: false,
  error: null,
  expanded: null,
  deleting: new Set(),
  reimports: {},

  fetchSources: async () => {
    set({ isLoading: true });
    try {
      const { sources } = await listSources();
      set({ sources, error: null, loaded: true });
    } catch (err) {
      set({ error: sourceErrorMessage(err, 'Could not load sources'), loaded: true });
    } finally {
      set({ isLoading: false });
    }
  },

  setExpanded: (name) => set({ expanded: name }),

  deleteSource: async (name) => {
    set((s) => ({ deleting: new Set(s.deleting).add(name) }));
    try {
      const resp = await deleteSourceRequest(name);
      set((s) => ({
        sources: s.sources.filter((e) => e.name !== name),
        expanded: s.expanded === name ? null : s.expanded,
      }));
      await refreshAfterMutation();
      return { rowsDeleted: resp.rows_deleted };
    } finally {
      set((s) => {
        const next = new Set(s.deleting);
        next.delete(name);
        return { deleting: next };
      });
    }
  },

  renameSource: async (name, displayName) => {
    const entry = await renameSourceRequest(name, { display_name: displayName });
    set((s) => ({ sources: s.sources.map((e) => (e.name === name ? entry : e)) }));
    return entry;
  },

  reimportSource: async (name) => {
    const resp = await reimportSourceRequest(name);
    const inFlight: ReimportInFlight = {
      name,
      jobId: resp.job_id,
      path: resp.path,
      rowsStored: 0,
      state: 'running',
    };
    set((s) => ({ reimports: { ...s.reimports, [name]: inFlight } }));
    await get().fetchSources();
    await refreshAfterMutation();
    const update = (patch: Partial<ReimportInFlight>) =>
      set((s) =>
        s.reimports[name]
          ? { reimports: { ...s.reimports, [name]: { ...s.reimports[name], ...patch } } }
          : {}
      );
    try {
      const job = await waitForIngestJob(
        resp.job_id,
        (j) => update({ rowsStored: j.rows_stored }),
        new AbortController().signal
      );
      update({ state: job.state, rowsStored: job.rows_stored, error: job.error || undefined });
    } catch (err) {
      update({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    await get().fetchSources();
    await refreshAfterMutation();
  },

  clearReimport: (name) =>
    set((s) => {
      const next = { ...s.reimports };
      delete next[name];
      return { reimports: next };
    }),
}));
