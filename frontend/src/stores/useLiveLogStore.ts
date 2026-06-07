import { LiveSourceStatusEvent } from '@/lib/api-types';
import { create } from 'zustand';

export const LIVE_ROW_LIMIT = 1000;
export const LIVE_SOURCE_STATUS_LIMIT = 100;

type LiveRow = Record<string, any>;

export interface LiveLogState {
  connected: boolean;
  paused: boolean;
  subscriberId: string | null;
  rows: LiveRow[];
  skippedCount: number;
  sourceStatuses: Record<string, LiveSourceStatusEvent>;
  error: string | null;

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

export function liveActiveSourceCount(state: Pick<LiveLogState, 'sourceStatuses'>): number {
  return Object.values(state.sourceStatuses).filter(status => status.status === 'started').length;
}

export function isLiveDataAvailable(state: Pick<LiveLogState, 'rows' | 'sourceStatuses'>): boolean {
  return state.rows.length > 0 || liveActiveSourceCount(state) > 0;
}

function trimSourceStatuses(
  sourceStatuses: Record<string, LiveSourceStatusEvent>,
  protectedSourceID: string,
): Record<string, LiveSourceStatusEvent> {
  const entries = Object.entries(sourceStatuses);
  if (entries.length <= LIVE_SOURCE_STATUS_LIMIT) return sourceStatuses;

  let overflow = entries.length - LIVE_SOURCE_STATUS_LIMIT;
  const prune = (shouldPrune: (status: LiveSourceStatusEvent) => boolean) => {
    for (const [sourceID, sourceStatus] of entries) {
      if (overflow <= 0) break;
      if (sourceID === protectedSourceID || !(sourceID in sourceStatuses) || !shouldPrune(sourceStatus)) continue;
      delete sourceStatuses[sourceID];
      overflow--;
    }
  };

  prune(status => status.status !== 'started');
  prune(() => true);
  return sourceStatuses;
}

export const useLiveLogStore = create<LiveLogState>((set) => ({
  connected: false,
  paused: false,
  subscriberId: null,
  rows: [],
  skippedCount: 0,
  sourceStatuses: {},
  error: null,

  setConnected: (connected) => set({ connected }),
  setPaused: (paused) => set({ paused }),
  setSubscriberId: (subscriberId) => set({ subscriberId }),
  appendRows: (rows) => set((state) => {
    if (rows.length === 0) return state;
    const incoming = rows.length > LIVE_ROW_LIMIT
      ? rows.slice(rows.length - LIVE_ROW_LIMIT)
      : rows;
    const newestFirst = [...incoming].reverse();
    const retainedCurrentRows = state.rows.slice(0, Math.max(0, LIVE_ROW_LIMIT - newestFirst.length));
    const overflow = Math.max(0, state.rows.length + rows.length - LIVE_ROW_LIMIT);
    return {
      rows: [...newestFirst, ...retainedCurrentRows],
      skippedCount: state.skippedCount + overflow,
    };
  }),
  recordSkipped: (count) => set((state) => {
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    if (safeCount === 0) return state;
    return { skippedCount: state.skippedCount + safeCount };
  }),
  setSourceStatus: (status) => set((state) => {
    const sourceStatuses = {
      ...state.sourceStatuses,
      [status.source_id]: status,
    };

    return { sourceStatuses: trimSourceStatuses(sourceStatuses, status.source_id) };
  }),
  setError: (error) => set({ error }),
  clearRows: () => set({ rows: [], skippedCount: 0 }),
  reset: () => set({
    connected: false,
    paused: false,
    subscriberId: null,
    rows: [],
    skippedCount: 0,
    sourceStatuses: {},
    error: null,
  }),
}));
