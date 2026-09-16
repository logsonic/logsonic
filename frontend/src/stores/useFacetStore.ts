import { create } from 'zustand';

import type { FacetsResponse } from '@/lib/api-types';

/**
 * Facets for the Fields panel. Not persisted: facets describe one search
 * window and are refetched (via the metadata request in useSearchLogs, or the
 * panel's own refresh) whenever the window changes while the panel is open.
 *
 * `fingerprint` records which search state the current facets belong to, so
 * the panel can tell "stale from an earlier query" from "current" without
 * clearing them -- clearing would flash an empty panel on every toggle.
 */
interface FacetState {
  facets: FacetsResponse | null;
  fingerprint: string | null;
  panelOpen: boolean;
  isLoading: boolean;
  error: string | null;
  expandedFields: Set<string>;
  showAllFields: Set<string>;

  setFacets: (facets: FacetsResponse | null, fingerprint: string | null) => void;
  setPanelOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  toggleExpanded: (field: string) => void;
  toggleShowAll: (field: string) => void;
}

const toggleInSet = (set: Set<string>, value: string): Set<string> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

export const useFacetStore = create<FacetState>((set) => ({
  facets: null,
  fingerprint: null,
  panelOpen: false,
  isLoading: false,
  error: null,
  expandedFields: new Set(),
  showAllFields: new Set(),

  setFacets: (facets, fingerprint) => set({ facets, fingerprint, error: null }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  toggleExpanded: (field) => set((s) => ({ expandedFields: toggleInSet(s.expandedFields, field) })),
  toggleShowAll: (field) => set((s) => ({ showAllFields: toggleInSet(s.showAllFields, field) })),
}));
