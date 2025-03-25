import { useCallback } from 'react';
import { useGetLogs, ApiPerformanceMetrics } from './useApi';
import { LogResponse, LogQueryParams } from '@/lib/api-types';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { calculateRelativeDateRange } from '@/lib/date-utils';

/**
 * Hook for searching logs that uses the LogResultStore for state management
 */
export const useSearchLogs = (
  onSearchComplete?: (data: LogResponse) => void
) => {
  // Get the stores directly using the hooks
  const store = useSearchQueryParamsStore();
  const logResultStore = useLogResultStore();
  const { execute: fetchLogs, isLoading: apiLoading, performanceMetrics } = useGetLogs();

  // Create a stable search function that doesn't change on every render
  const searchLogs = useCallback(async () => {
    try {
      // Set loading state
      logResultStore.setLoading(true);
      logResultStore.setError(null);
      
      let startDate: Date = store.UTCTimeSince;
      let endDate: Date = store.UTCTimeTo;
      if (store.isRelative) { 
        const { startDate: relativeStartDate, endDate: relativeEndDate } = calculateRelativeDateRange(store.relativeValue);
        startDate = relativeStartDate;
        endDate = relativeEndDate;
      }
      // Prepare query parameters from store
      // The backend always expects UTC timestamps regardless of the displayed timezone
      const params : LogQueryParams = {
        query: store.searchQuery,
        _src: store.sources.length > 0 ? store.sources.join(',') : undefined,
        start_date: startDate.toISOString(), // Already in UTC format
        end_date: endDate.toISOString(), // Already in UTC format
        limit: store.pageSize,
        offset: (store.currentPage - 1) * store.pageSize,
        sort_by: store.sortBy,
        sort_order: store.sortOrder
      };
      
      // Execute the search
      const result = await fetchLogs(params);
      
      if (result) {
        // Update the store with the result
        logResultStore.setLogData(result);
        
        // Update search params store with metadata from result
        if (result.available_columns) {
          store.setAvailableColumns(result.available_columns);
        }
        
        if (result.total_count !== undefined) {
          store.setResultCount(result.total_count);
        }
        if (result.start_date !== undefined) {
          try {
            const startDate = new Date(result.start_date);
            if (!isNaN(startDate.getTime())) {
              store.setLastSearchStart(startDate);
            }
          } catch (e) {
            console.warn('Invalid start_date format:', result.start_date);
          }
        }
        if (result.end_date !== undefined) {
          try {
            const endDate = new Date(result.end_date);
            if (!isNaN(endDate.getTime())) {
              store.setLastSearchEnd(endDate);
            }
          } catch (e) {
            console.warn('Invalid end_date format:', result.end_date);
          }
        }
        
        // Store performance metrics
        const apiTime = performanceMetrics?.executionTime || null;
        const backendTime = result.time_taken || null;
        const indexTime = result.index_query_time || null;
        
        store.setPerformanceMetrics(apiTime, backendTime, indexTime);
        
        // Call the onSearchComplete callback if provided
        if (onSearchComplete) {
          onSearchComplete(result);
        }
        
        return result;
      }
    } catch (error) {
      logResultStore.setError(
        error instanceof Error 
          ? error.message 
          : 'An unknown error occurred while searching logs'
      );
      console.error('Error searching logs:', error);
    } finally {
      logResultStore.setLoading(false);
    }
    
    return null;
  }, [
    store.searchQuery,
    store.sources,
    store.UTCTimeSince,
    store.UTCTimeTo,
    store.pageSize,
    store.currentPage,
    store.sortBy,
    store.sortOrder,
    logResultStore,
    fetchLogs,
    onSearchComplete,
    performanceMetrics,
    store.setPerformanceMetrics
  ]);

  return {
    searchLogs,
    isLoading: apiLoading || logResultStore.isLoading,
    performanceMetrics,
  };
}; 