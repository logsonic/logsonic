import { LogQueryParams, LogResponse } from '@/lib/api-types';
import { getLogs } from '@/lib/api-client';
import { calculateRelativeDateRange } from '@/lib/date-utils';
import { useFacetStore } from '@/stores/useFacetStore';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useCallback, useEffect, useRef } from 'react';
import { useGetLogs } from './useApi';

type SearchWindowState = Pick<
  ReturnType<typeof useSearchQueryParamsStore.getState>,
  'searchQuery' | 'sources' | 'sourcesInitialized' | 'isRelative' | 'relativeValue' | 'customRelativeUnit' | 'customRelativeCount' | 'UTCTimeSince' | 'UTCTimeTo'
>;

/** Resolve the store's window (relative or absolute) to concrete UTC bounds. */
export const resolveSearchWindow = (store: SearchWindowState): { startDate: Date; endDate: Date } => {
  if (store.isRelative) {
    return calculateRelativeDateRange(store.relativeValue, store.customRelativeUnit, store.customRelativeCount);
  }
  return { startDate: store.UTCTimeSince, endDate: store.UTCTimeTo };
};

/**
 * Identity of "the current search window" -- query, sources and resolved
 * range -- used by the Fields panel to tell whether its facets are current.
 * Relative ranges are resolved to the minute so a panel doesn't refetch every
 * render while the clock ticks. Consequence: two searches inside the same
 * wall-clock minute share a fingerprint even if a live tail added rows in
 * between, so the panel's "stale" hint can lag by up to a minute; the facets
 * themselves are refetched with the next search regardless.
 */
export const searchFingerprint = (store: SearchWindowState): string => {
  const { startDate, endDate } = resolveSearchWindow(store);
  const minute = (d: Date) => Math.floor(d.getTime() / 60000);
  const sources = store.sourcesInitialized ? [...store.sources].sort().join(',') : '*';
  return `${store.searchQuery}|${sources}|${minute(startDate)}|${minute(endDate)}`;
};

let activeMetadataController: AbortController | null = null;

/**
 * The deferred second request: chart distribution (and, when the Fields
 * panel is open, facets) for the current window. Kept out of the first page
 * request because a facet scan roughly doubles it. `fields` here only
 * projects the returned row; the server's facet scan builds its own field
 * list, so the projection does not starve the facets.
 */
export const refreshSearchMetadata = async (opts: { includeFacets: boolean; params?: LogQueryParams }): Promise<void> => {
  const query = useSearchQueryParamsStore.getState();
  const facetStore = useFacetStore.getState();
  const fingerprint = searchFingerprint(query);
  const { startDate, endDate } = resolveSearchWindow(query);
  const params: LogQueryParams = opts.params ?? {
    query: query.searchQuery,
    _src: query.sourcesInitialized ? query.sources.join(',') : undefined,
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
  };
  activeMetadataController?.abort();
  const controller = new AbortController();
  activeMetadataController = controller;
  if (opts.includeFacets) facetStore.setLoading(true);
  try {
    const metadata = await getLogs({
      ...params,
      limit: 1,
      offset: 0,
      sort_by: 'timestamp',
      sort_order: 'desc',
      fields: 'timestamp,_src',
      include_distribution: true,
      include_facets: opts.includeFacets,
    }, controller.signal);
    if (activeMetadataController !== controller) return;
    const current = useLogResultStore.getState().logData;
    if (current) {
      useLogResultStore.getState().setLogData({
        ...current,
        total_count: metadata.total_count,
        log_distribution: metadata.log_distribution,
      });
    }
    if (opts.includeFacets && metadata.facets) {
      useFacetStore.getState().setFacets(metadata.facets, fingerprint);
    }
  } catch (metadataError) {
    if (!controller.signal.aborted) {
      console.warn('Failed to load log distribution:', metadataError);
      if (opts.includeFacets) {
        useFacetStore.getState().setError(metadataError instanceof Error ? metadataError.message : 'request failed');
      }
    }
  } finally {
    if (activeMetadataController === controller) {
      activeMetadataController = null;
      if (opts.includeFacets) useFacetStore.getState().setLoading(false);
    }
  }
};

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
  const activeSearchRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeSearchRef.current?.abort();
    activeMetadataController?.abort();
  }, []);

  // Create a stable search function that doesn't change on every render
  const searchLogs = useCallback(async () => {
    activeSearchRef.current?.abort();
    const controller = new AbortController();
    activeSearchRef.current = controller;
    try {
      // Set loading state
      logResultStore.setLoading(true);
      logResultStore.setError(null);
      
      let startDate: Date = store.UTCTimeSince;
      let endDate: Date = store.UTCTimeTo;
      if (store.isRelative) {
        const { startDate: relativeStartDate, endDate: relativeEndDate } = calculateRelativeDateRange(
          store.relativeValue,
          store.customRelativeUnit,
          store.customRelativeCount
        );
        startDate = relativeStartDate;
        endDate = relativeEndDate;
      }
      // Prepare query parameters from store
      // The backend always expects UTC timestamps regardless of the displayed timezone
      const params : LogQueryParams = {
        query: store.searchQuery,
        _src: store.sourcesInitialized ? store.sources.join(',') : undefined,
        start_date: startDate.toISOString(), // Already in UTC format
        end_date: endDate.toISOString(), // Already in UTC format
        limit: store.pageSize,
        offset: (store.currentPage - 1) * store.pageSize,
        sort_by: store.sortBy,
        sort_order: store.sortOrder,
        // The first request discovers the complete schema. Once columns are
        // selected, project subsequent responses to the visible fields to
        // reduce JSON size and client parsing/render work.
        fields: store.selectedColumns.length > 0
          ? store.selectedColumns.join(',')
          : undefined,
        include_distribution: false,
      };
      
      // Execute the search
      const result = await fetchLogs(params, controller.signal);
      
      if (result) {
        // Update the store with the result
        logResultStore.setLogData(result);
        
        // Update search params store with metadata from result
        if (result.available_columns) {
          store.setAvailableColumns(result.available_columns, result.logs);
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

        // Chart facets roughly double a large-index request and are not needed
        // to render the first result page. Fetch them after the rows are
        // visible (with field facets too when the Fields panel is open).
        void refreshSearchMetadata({ includeFacets: useFacetStore.getState().panelOpen, params });

        return result;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return null;
      }
      logResultStore.setError(
        error instanceof Error 
          ? error.message 
          : 'An unknown error occurred while searching logs'
      );
      console.error('Error searching logs:', error);
    } finally {
      if (activeSearchRef.current === controller) {
        activeSearchRef.current = null;
        logResultStore.setLoading(false);
      }
    }
    
    return null;
  }, [
    store,
    logResultStore,
    fetchLogs,
    onSearchComplete,
    performanceMetrics,
  ]);

  return {
    searchLogs,
    isLoading: apiLoading || logResultStore.isLoading,
    performanceMetrics,
  };
};
