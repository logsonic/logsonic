import { create } from 'zustand';
import { SystemInfoResponse } from '@/lib/api-types';
import { getSystemInfo } from '@/lib/api-client';

interface SystemInfoState {
  // Data
  systemInfo: SystemInfoResponse | null;
  error: string | null;
  isLoading: boolean;
  
  // Actions
  setSystemInfo: (data: SystemInfoResponse | null) => void;
  setError: (error: string | null) => void;
  setLoading: (isLoading: boolean) => void;
  reset: () => void;
  refreshSystemInfo: (refresh?: boolean) => Promise<void>;
}

/**
 * Store for managing system information
 * This store is not persisted and is used to share system info between components
 */
export const useSystemInfoStore = create<SystemInfoState>((set) => ({
  // Initial state
  systemInfo: null,
  error: null,
  isLoading: false,
  
  // Actions
  setSystemInfo: (data) => set({ systemInfo: data }),
  setError: (error) => set({ error }),
  setLoading: (isLoading) => set({ isLoading }),
  reset: () => set({ systemInfo: null, error: null, isLoading: false }),
  
  // Helper function to refresh system info
  refreshSystemInfo: async (refresh?: boolean) => {
    set({ isLoading: true, error: null });
    try {
      const data = await getSystemInfo(refresh);
      set({ systemInfo: data, isLoading: false });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch system information';
      set({ error: errorMessage, isLoading: false });
      throw err;
    }
  }
})); 