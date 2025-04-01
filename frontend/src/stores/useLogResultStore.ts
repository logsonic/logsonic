import { LogResponse } from '@/lib/api-types';
import { create } from 'zustand';

interface LogResultState {
  // Data
  logData: LogResponse | null;
  error: string | null;
  isLoading: boolean;
  
  // Actions
  setLogData: (data: LogResponse | null) => void;
  setError: (error: string | null) => void;
  setLoading: (isLoading: boolean) => void;
  reset: () => void;
}

/**
 * Store for managing log search results
 * This store is not persisted and is used to share log data between components
 */
export const useLogResultStore = create<LogResultState>((set, get) => ({
  // Initial state
  logData: null,
  error: null,
  isLoading: false,
  
  // Actions
  setLogData: (data) => set({ logData: data }),
  setError: (error) => set({ error }),
  setLoading: (isLoading) => set({ isLoading }),
  reset: () => set({ logData: null, error: null, isLoading: false }),
})); 