import { LiveSourceStatusEvent } from '@/lib/api-types';
import { create } from 'zustand';

export const LIVE_ROW_LIMIT = 1000;

type LiveRow = Record<string, any>;

interface LiveLogState {
  enabled: boolean;
  connected: boolean;
  paused: boolean;
  subscriberId: string | null;
  rows: LiveRow[];
  skippedCount: number;
  sourceStatuses: Record<string, LiveSourceStatusEvent>;
  error: string | null;

  setEnabled: (enabled: boolean) => void;
  setConnected: (connected: boolean) => void;
  setPaused: (paused: boolean) => void;
  setSubscriberId: (subscriberId: string | null) => void;
  appendRows: (rows: LiveRow[]) => void;
  recordSkipped: (count: number) => void;
  setSourceStatus: (status: LiveSourceStatusEvent) => void;
  setError: (error: string | null) => void;
  clearRows: () => void;
  reset: () => void;
}

export const useLiveLogStore = create<LiveLogState>((set) => ({
  enabled: false,
  connected: false,
  paused: false,
  subscriberId: null,
  rows: [],
  skippedCount: 0,
  sourceStatuses: {},
  error: null,

  setEnabled: (enabled) => set((state) => ({
    enabled,
    connected: enabled ? state.connected : false,
    paused: enabled ? state.paused : false,
    subscriberId: enabled ? state.subscriberId : null,
    error: enabled ? state.error : null,
  })),
  setConnected: (connected) => set({ connected }),
  setPaused: (paused) => set({ paused }),
  setSubscriberId: (subscriberId) => set({ subscriberId }),
  appendRows: (rows) => set((state) => {
    if (rows.length === 0) return state;
    const newestFirst = [...rows].reverse();
    const combined = [...newestFirst, ...state.rows];
    const overflow = Math.max(0, combined.length - LIVE_ROW_LIMIT);
    return {
      rows: combined.slice(0, LIVE_ROW_LIMIT),
      skippedCount: state.skippedCount + overflow,
    };
  }),
  recordSkipped: (count) => set((state) => ({
    skippedCount: state.skippedCount + Math.max(0, count),
  })),
  setSourceStatus: (status) => set((state) => ({
    sourceStatuses: {
      ...state.sourceStatuses,
      [status.source_id]: status,
    },
  })),
  setError: (error) => set({ error }),
  clearRows: () => set({ rows: [], skippedCount: 0 }),
  reset: () => set({
    enabled: false,
    connected: false,
    paused: false,
    subscriberId: null,
    rows: [],
    skippedCount: 0,
    sourceStatuses: {},
    error: null,
  }),
}));
