import { useState, useCallback } from 'react';
import * as api from '@/lib/api-client';
import { IngestSessionOptions } from '@/lib/api-types';

// Interface for performance metrics
export interface ApiPerformanceMetrics {
  executionTime: number; // in microseconds
  startTimestamp: number;
  endTimestamp: number;
}

// Generic hook for API calls with loading and error states
export function useApi<T, P extends any[]>(
  apiFunction: (...args: P) => Promise<T>
) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [performanceMetrics, setPerformanceMetrics] = useState<ApiPerformanceMetrics | null>(null);

  const execute = useCallback(
    async (...args: P) => {
      setIsLoading(true);
      setError(null);
      
      const startTime = performance.now();
      
      try {
        const result = await apiFunction(...args);
        const endTime = performance.now();
        
        // Calculate performance metrics
        const metrics: ApiPerformanceMetrics = {
          executionTime: Math.round((endTime - startTime) * 1000), // Convert to microseconds
          startTimestamp: startTime,
          endTimestamp: endTime
        };
        
        setPerformanceMetrics(metrics);
        setData(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [apiFunction]
  );

  return {
    data,
    isLoading,
    error,
    execute,
    performanceMetrics,
  };
}

// Pre-configured hooks for specific API endpoints
export function useGetLogs() {
  return useApi(api.getLogs);
}

export function useIngestLogs() {
  return useApi(api.ingestLogs);
}

export function useIngestStart() {
  return useApi(api.ingestStart);
}

export function useIngestEnd() {
  return useApi(api.ingestEnd);
}

export function useIngestFile() {
  return useApi(api.ingestFile);
}

export function useParseLogs() {
  return useApi(api.parseLogs);
}

export function useSuggestPatterns() {
  return useApi(api.suggestPatterns);
}

export function useGrokPattern() {
  return useApi(api.createGrokPattern);
}

export function useSystemInfo() {
  return useApi(api.getSystemInfo);
}

export function useTokenizerOperations() {
  const startIngest = useApi(api.ingestStart);
  const endIngest = useApi(api.ingestEnd);
  
  return {
    startIngest,
    endIngest,
  };
}

export function useClearLogs() {
  return useApi(api.clearLogs);
} 