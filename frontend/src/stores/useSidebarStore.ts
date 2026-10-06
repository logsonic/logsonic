import { create } from 'zustand';

import type { SidebarTabId } from '@/components/Home/SidebarPanel';

export const SIDEBAR_PANELS: SidebarTabId[] = ['filter', 'fields', 'sources', 'styling'];

/**
 * Lets code outside Home (the agent bridge) open or close a sidebar panel.
 * Home owns the real state (active tab + collapsed); it applies `pending`
 * when set -- also on mount, so a request made while another page is shown
 * lands once Home renders -- clears it, and mirrors what is visible into
 * `current` so a caller can confirm the result.
 */
interface SidebarState {
  pending: { panel: SidebarTabId; open: boolean } | null;
  current: { panel: SidebarTabId; open: boolean };
  request: (panel: SidebarTabId, open: boolean) => void;
  clearPending: () => void;
  setCurrent: (panel: SidebarTabId, open: boolean) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  pending: null,
  current: { panel: 'filter', open: false },
  request: (panel, open) => set({ pending: { panel, open } }),
  clearPending: () => set({ pending: null }),
  setCurrent: (panel, open) => set({ current: { panel, open } }),
}));
