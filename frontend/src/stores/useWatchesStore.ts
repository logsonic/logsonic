import { create } from 'zustand';

import type { Watch, WatchRequest } from '@/lib/api-types';

import {
  createWatch as createWatchRequest,
  deleteWatch as deleteWatchRequest,
  listWatches,
  pauseWatch as pauseWatchRequest,
  resumeWatch as resumeWatchRequest,
} from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-errors';

interface WatchesState {
  watches: Watch[];
  loaded: boolean;
  isLoading: boolean;
  error: string | null;

  fetchWatches: () => Promise<void>;
  createWatch: (req: WatchRequest) => Promise<Watch>;
  deleteWatch: (id: string) => Promise<void>;
  pauseWatch: (id: string) => Promise<Watch>;
  resumeWatch: (id: string) => Promise<Watch>;
}

/** Number of watches currently running (not paused) — the status-bar indicator. */
export const activeWatchCount = (state: Pick<WatchesState, 'watches'>): number =>
  state.watches.filter((w) => !w.paused).length;

const replace = (list: Watch[], next: Watch): Watch[] =>
  list.map((w) => (w.id === next.id ? next : w));

export const useWatchesStore = create<WatchesState>((set) => ({
  watches: [],
  loaded: false,
  isLoading: false,
  error: null,

  fetchWatches: async () => {
    set({ isLoading: true });
    try {
      const { watches } = await listWatches();
      set({ watches, error: null, loaded: true });
    } catch (err) {
      set({ error: apiErrorMessage(err, 'Could not load watched folders'), loaded: true });
    } finally {
      set({ isLoading: false });
    }
  },

  createWatch: async (req) => {
    const created = await createWatchRequest(req);
    set((s) => ({ watches: [...s.watches, created] }));
    return created;
  },

  deleteWatch: async (id) => {
    await deleteWatchRequest(id);
    set((s) => ({ watches: s.watches.filter((w) => w.id !== id) }));
  },

  pauseWatch: async (id) => {
    const next = await pauseWatchRequest(id);
    set((s) => ({ watches: replace(s.watches, next) }));
    return next;
  },

  resumeWatch: async (id) => {
    const next = await resumeWatchRequest(id);
    set((s) => ({ watches: replace(s.watches, next) }));
    return next;
  },
}));
