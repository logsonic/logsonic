import { create } from 'zustand';

type LogEntry = Record<string, any>;

const MAX_STREAM_ROWS = 10_000;

interface StreamState {
  isLive: boolean;
  isPaused: boolean;
  streamedLogs: LogEntry[];
  wsRef: WebSocket | null;

  setLive: (v: boolean) => void;
  setPaused: (v: boolean) => void;
  setWsRef: (ws: WebSocket | null) => void;
  appendLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  sendFilter: (query: string) => void;
  setPattern: (patternId: string) => void;
}

export const useStreamStore = create<StreamState>((set, get) => ({
  isLive: false,
  isPaused: false,
  streamedLogs: [],
  wsRef: null,

  setLive: (v) => set({ isLive: v }),
  setPaused: (v) => set({ isPaused: v }),
  setWsRef: (ws) => set({ wsRef: ws }),

  appendLog: (entry) =>
    set((state) => ({
      streamedLogs: [entry, ...state.streamedLogs].slice(0, MAX_STREAM_ROWS),
    })),

  clearLogs: () => set({ streamedLogs: [] }),

  toggle: () => {
    const { isLive, wsRef } = get();
    if (isLive) {
      wsRef?.close();
      set({ isLive: false, isPaused: false, wsRef: null, streamedLogs: [] });
    } else {
      set({ isLive: true });
    }
  },

  pause: () => {
    const { wsRef } = get();
    if (wsRef?.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify({ type: 'pause' }));
    }
    set({ isPaused: true });
  },

  resume: () => {
    const { wsRef } = get();
    if (wsRef?.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify({ type: 'resume' }));
    }
    set({ isPaused: false });
  },

  sendFilter: (query: string) => {
    const { wsRef } = get();
    if (wsRef?.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify({ type: 'filter', query }));
    }
  },

  setPattern: (patternId: string) => {
    const { wsRef } = get();
    if (wsRef?.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify({ type: 'set_pattern', patternId }));
    }
  },
}));
