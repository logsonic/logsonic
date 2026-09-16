import { create } from 'zustand';

import type { SavedQuery } from '@/lib/api-types';

// The current session's starred queries, staged here until a workspace save
// persists them (spec now-03 step 7). Unlike useColorRuleStore, this is
// deliberately NOT persisted to localStorage: saved queries live in the
// workspace, not the browser, so this store is only a place to hold
// "about to be saved" state between a star click and the next
// create/update-workspace call -- persisting it separately would risk it
// drifting out of sync with whatever a workspace file already has.
export interface SavedQueryDraftStoreState {
  savedQueries: SavedQuery[];
  addSavedQuery: (query: Omit<SavedQuery, 'id' | 'created_at'>) => SavedQuery;
  removeSavedQuery: (id: string) => void;
  setAll: (savedQueries: SavedQuery[]) => void;
}

export const useSavedQueryDraftStore = create<SavedQueryDraftStoreState>((set, get) => ({
  savedQueries: [],

  addSavedQuery: (query) => {
    const saved: SavedQuery = {
      ...query,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    set({ savedQueries: [...get().savedQueries, saved] });
    return saved;
  },

  removeSavedQuery: (id) => {
    set({ savedQueries: get().savedQueries.filter((sq) => sq.id !== id) });
  },

  // Fully replaces the draft -- used when a workspace loads (its own
  // saved_queries become the draft) and implicitly on logout/reset paths
  // that already clear other per-workspace state the same way (colorRules).
  setAll: (savedQueries) => set({ savedQueries: [...savedQueries] }),
}));
