import { create } from 'zustand';
import { 
  CloudWatchLogGroup, 
  CloudWatchLogStream,
  LogPaginationState,
  SelectedStream 
} from '../types';
import { useState } from 'node_modules/react-resizable-panels/dist/declarations/src/vendor/react';

interface CloudWatchState {
  // Authentication
  authMethod: 'profile' | 'keys';
  region: string;
  profile: string;
  retrievedLogs: string[];
  estimatedLogCount: number;
  // Log Groups & Streams data
  logGroups: CloudWatchLogGroup[];
  expandedGroups: Record<string, boolean>;
  loadingStreams: Record<string, boolean>;
  searchQuery: string;
  selectedStream: SelectedStream | null;
  streamSize: number | null;
  logPagination: LogPaginationState;
  
  // Loading states
  isLoading: boolean;
  error: string | null;
  
  // Actions
  setAuthMethod: (method: 'profile' | 'keys') => void;
  setRegion: (region: string) => void;
  setProfile: (profile: string) => void;
  setLogPagination: (pagination: LogPaginationState) => void;
  setRetrievedLogs: (logs: string[]) => void;
  setEstimatedLogCount: (count: number) => void;
  setLogGroups: (groups: CloudWatchLogGroup[]) => void;
  setStreamsForGroup: (groupName: string, streams: CloudWatchLogStream[]) => void;
  toggleGroupExpanded: (groupName: string) => void;
  setLoadingStreams: (groupName: string, isLoading: boolean) => void;
  setSelectedStream: (groupName: string | null, streamName: string | null, streamSize: number | null) => void;
  setSearchQuery: (query: string) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  
  // Resets
  reset: () => void;
  resetSelection: () => void;
}

const initialState = {
  // Authentication
  authMethod: 'profile' as const,
  region: 'us-east-1',
  profile: 'default',
  logPagination: {
    nextToken: null,
    hasMore: false,
    isLoading: false
  }, 
  estimatedLogCount: 0,
  retrievedLogs: [],
  // Log Groups & Streams data
  logGroups: [],
  expandedGroups: {},
  loadingStreams: {},
  searchQuery: '',
  selectedStream: null,
  streamSize: null, 

  // Loading states
  isLoading: false,
  error: null,
};

export const useCloudWatchStore = create<CloudWatchState>((set) => ({
  ...initialState,
  
  // Actions
  setAuthMethod: (method) => set({ authMethod: method }),
  setRegion: (region) => set({ region }),
  setProfile: (profile) => set({ profile }),
  
  setLogGroups: (groups) => set({ 
    logGroups: groups,
    // Only reset expansion, but keep the selection to maintain it between steps
    expandedGroups: {}
    // Don't reset selectedStream here
    // selectedStream: null,
  }),
  
  setLogPagination: (pagination) => set({ logPagination: pagination }),
  setRetrievedLogs: (logs) => set({ retrievedLogs: logs }),
  setEstimatedLogCount: (count) => set({ estimatedLogCount: count }),
  setStreamsForGroup: (groupName, streams) => set((state) => {
    // Find the log group and update its streams
    const updatedLogGroups = state.logGroups.map(group => 
      group.name === groupName ? { ...group, streams } : group
    );
    
    return { logGroups: updatedLogGroups };
  }),
  
  toggleGroupExpanded: (groupName) => set((state) => ({
    expandedGroups: {
      ...state.expandedGroups,
      [groupName]: !state.expandedGroups[groupName]
    }
  })),
  
  setLoadingStreams: (groupName, isLoading) => set((state) => ({
    loadingStreams: {
      ...state.loadingStreams,
      [groupName]: isLoading
    }
  })),
  
  setSelectedStream: (groupName, streamName, streamSize) => set({
    selectedStream: groupName && streamName ? { groupName, streamName } : null,
    streamSize: streamSize || null,
  }),
  
  setSearchQuery: (query) => set({ searchQuery: query }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  
  // Resets
  reset: () => set(initialState),
  resetSelection: () => set({ selectedStream: null }),
})); 