import { calculatePresetRelativeDate, calculateRelativeDate, calculateRelativeDateRange, RELATIVE_DATE_PRESETS } from '@/lib/date-utils';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';


// Define the search store state
export interface SearchQueryParamsStoreState {
  // State
  searchQuery: string; // Actual keywords input by the user
  firstLoad: boolean; //Set when a new file has been ingested and home page opens for the first time
  sources: string[]; // _src filter
  dirty: boolean; // Flag to indicate if the search query has been modified
  isLoading: boolean; // Flag to indicate if the search is in progress
  isRelative: boolean; // Flag to indicate if the time range is relative
  relativeValue: string; // The relative time range value (e.g. "last-24-hours")
  customRelativeCount: number; // The count value for custom relative time
  customRelativeUnit: string; // The unit for custom relative time (e.g. "days", "hours")
  resultCount: number; // The total number of results returned by the current search
  resultQueryLatency: number; // The latency of the search query in milliseconds
  resultReceviedOn: Date;
  UTCTimeSince: Date;
  UTCTimeTo: Date;    
  lastSearchStart: Date;
  lastSearchEnd: Date;
  // Unix timestamp in milliseconds for the start date/time
  UTCTimeSinceMs: number;
  // Unix timestamp in milliseconds for the end date/time
  UTCTimeToMs: number;
  timeZone: string;
  // Flag to indicate if a search has been performed
  hasSearched: boolean;

  // Performance metrics
  apiExecutionTime: number | null; // API call time in microseconds
  backendLatency: number | null; // Backend processing time in microseconds
  indexQueryTime: number | null; // Index query time in microseconds

  // Display settings for the current search results
  // Since we use server side pagination and sorting, we need to store the following settings
  sortBy: string;
  sortOrder: string;
  pageSize: number;
  currentPage: number;
  availableColumns: string[]; // All available columns from the search results
  selectedColumns: string[]; // Also used for column ordering
  mandatoryColumns: string[];
  isColumnLocked: boolean;
  columnWidths: Record<string, number>;
  
  // Actions
  setSearchQuery: (searchQuery: string) => void;
  setFirstLoad: (firstLoad: boolean) => void;
  setSources: (sources: string[]) => void;
  setLoading: (isLoading: boolean) => void;
  setResultCount: (resultCount: number) => void;
  setResultQueryLatency: (resultQueryLatency: number) => void;
  setResultReceviedOn: (resultReceviedOn: Date) => void;
  setUTCTimeSince: (UTCTimeSince: Date) => void;
  setUTCTimeTo: (UTCTimeTo: Date) => void;
  setUTCTimeSinceMs: (UTCTimeSinceMs: number) => void;
  setUTCTimeToMs: (UTCTimeToMs: number) => void;
  setTimeZone: (timeZone: string) => void;
  setIsRelative: (isRelative: boolean) => void;
  setCustomRelativeCount: (customRelativeCount: number) => void;
  setCustomRelativeUnit: (customRelativeUnit: string) => void;
  setPerformanceMetrics: (apiTime: number | null, backendTime: number | null, indexTime: number | null) => void;
  clearSearchQuery: () => void;
  triggerSearch: () => void;
  setRelativeValue: (relativeValue: string) => void;
  updateRelativeValue: () => void;
  setLastSearchStart: (lastSearchStart: Date) => void;
  setLastSearchEnd: (lastSearchEnd: Date) => void;
  setSortBy: (sortBy: string) => void;
  setSortOrder: (sortOrder: string) => void;
  setPageSize: (pageSize: number) => void;
  setCurrentPage: (currentPage: number) => void;
  setAvailableColumns: (availableColumns: string[], logs?: Array<Record<string, unknown>>) => void;
  setSelectedColumns: (selectedColumns: string[]) => void;
  setColumnWidths: (columnWidths: Record<string, number>) => void;
  setColumnLocked: (columnLocked: boolean) => void;
  updateColumnWidth: (column: string, width: number) => void;
  resetPagination: () => void;
  resetStore: () => void;
  // URL parameter functions
  syncWithUrlParams: () => void;
  updateUrlParams: () => void;
}

// Helper function to ensure dates are properly parsed
const ensureDate = (value: unknown): Date => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  return new Date();
};

// Helper to check if two dates are equal
const areDatesEqual = (date1: unknown, date2: unknown): boolean => {
  // Ensure both inputs are valid Date objects
  if (!(date1 instanceof Date) || !(date2 instanceof Date)) {
    return false;
  }
  
  // Check if both are valid dates (not NaN)
  if (isNaN(date1.getTime()) || isNaN(date2.getTime())) {
    return false;
  }
  
  return date1.getTime() === date2.getTime();
};

// Function to read URL search parameters
const getUrlParams = () => {
  if (typeof window === 'undefined') return null;
  
  // Get the hash part of the URL (excluding the # character)
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#?')) return null;
  
  // Extract the query string part after #?
  const queryString = hash.substring(2); // Remove the '#?' prefix
  const searchParams = new URLSearchParams(queryString);
  const params: Record<string, string> = {};
  
  searchParams.forEach((value, key) => {
    params[key] = value;
  });
  
  return params;
};

// Create the store with persistence
export const useSearchQueryParamsStore = create<SearchQueryParamsStoreState>()(
  persist(
    (set, get) => {
      // Initialize store with URL parameters if available
      const urlParams = getUrlParams();
      const initialTimeSince = urlParams?.since ? Number(urlParams.since) : Date.now() - 24 * 60 * 60 * 1000;
      const initialTimeTo = urlParams?.to ? Number(urlParams.to) : Date.now();
      const initialQuery = urlParams?.q || '';
      
      // Set up browser history event listener
      if (typeof window !== 'undefined') {
        window.addEventListener('popstate', () => {
          // When browser navigation occurs, sync with URL params
          const store = get();
          store.syncWithUrlParams();
        });
      }
      
      return {
        // Initial state
        searchQuery: initialQuery,
        firstLoad: true,
        sources: [],
        dirty: false,
        isLoading: false, 
        isRelative: false,
        relativeValue: 'last-24-hours',
        customRelativeCount: 1,
        customRelativeUnit: 'days',
        resultCount: 0,
        resultQueryLatency: 0,
        resultReceviedOn: new Date(),
        UTCTimeSince: new Date(initialTimeSince),
        UTCTimeTo: new Date(initialTimeTo),
        UTCTimeSinceMs: initialTimeSince,
        UTCTimeToMs: initialTimeTo,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        hasSearched: false,
        lastSearchStart: new Date(),
        lastSearchEnd: new Date(),
        // Performance metrics
        apiExecutionTime: null,
        backendLatency: null,
        indexQueryTime: null,
        
        sortBy: 'timestamp',
        sortOrder: 'desc',
        pageSize: 100,
        currentPage: 1,
        availableColumns: [],
        selectedColumns: [],
        mandatoryColumns: ['timestamp'],
        isColumnLocked: false,
        columnWidths: {},
        
        setFirstLoad: (firstLoad) => {
          set({ firstLoad });
        },
        // Actions
        setSearchQuery: (searchQuery) => {
          const currentState = get();
          if (currentState.searchQuery !== searchQuery) {
            set({ searchQuery });
            currentState.updateUrlParams();
          }
        },
        setSources: (sources) => {
          const currentState = get();
          if (currentState.sources !== sources) {
            set({ sources });
          }
        },
        setIsRelative: (isRelative) => {
          const currentState = get();
          if (currentState.isRelative !== isRelative) {
            set({ isRelative });
          }
        },
        setLoading: (isLoading) => {
          const currentState = get();
          if (currentState.isLoading !== isLoading) {
            set({ isLoading });
          }
        },
        setResultCount: (resultCount) => {
          const currentState = get();
          if (currentState.resultCount !== resultCount) {
            set({ resultCount });
          }
        },
        setResultQueryLatency: (resultQueryLatency) => {
          const currentState = get();
          if (currentState.resultQueryLatency !== resultQueryLatency) {
            set({ resultQueryLatency });
          }
        },
        setResultReceviedOn: (resultReceviedOn) => {
          const currentState = get();
          if (!areDatesEqual(currentState.resultReceviedOn, resultReceviedOn)) {
            set({ resultReceviedOn });
          }
        },
        setUTCTimeSince: (UTCTimeSince) => {
          const currentState = get();
          if (!areDatesEqual(currentState.UTCTimeSince, UTCTimeSince)) {
            set({ 
              UTCTimeSince,
              UTCTimeSinceMs: UTCTimeSince.getTime() // Also update the timestamp
            });
          }
        },
        setUTCTimeTo: (UTCTimeTo) => {
          const currentState = get();
          if (!areDatesEqual(currentState.UTCTimeTo, UTCTimeTo)) {
            set({ 
              UTCTimeTo,
              UTCTimeToMs: UTCTimeTo.getTime() // Also update the timestamp
            });
          }
        },
        setLastSearchStart: (lastSearchStart: Date) => {
          const currentState = get();
          const safeDate = ensureDate(lastSearchStart);
          if (!areDatesEqual(currentState.lastSearchStart, safeDate)) {
            set({ lastSearchStart: safeDate });
          }
        },  
        setLastSearchEnd: (lastSearchEnd: Date) => {
          const currentState = get();
          const safeDate = ensureDate(lastSearchEnd);
          if (!areDatesEqual(currentState.lastSearchEnd, safeDate)) {
            set({ lastSearchEnd: safeDate });
          }
        },
        setUTCTimeSinceMs: (UTCTimeSinceMs) => {
          const currentState = get();
          if (currentState.UTCTimeSinceMs !== UTCTimeSinceMs) {
            set({ 
              UTCTimeSinceMs,
              UTCTimeSince: new Date(UTCTimeSinceMs) // Also update the Date object
            });
          }
        },
        setUTCTimeToMs: (UTCTimeToMs) => {
          const currentState = get();
          if (currentState.UTCTimeToMs !== UTCTimeToMs) {
            set({ 
              UTCTimeToMs,
              UTCTimeTo: new Date(UTCTimeToMs) // Also update the Date object
            });
          }
        },
        setTimeZone: (timeZone) => {
          const currentState = get();
          if (currentState.timeZone !== timeZone) {
            set({ timeZone });
          }
        },
        setCustomRelativeCount: (customRelativeCount) => {
          const currentState = get();
          if (currentState.customRelativeCount !== customRelativeCount) {
            set({ customRelativeCount });
          }
        },
        setCustomRelativeUnit: (customRelativeUnit) => {
          const currentState = get();
          if (currentState.customRelativeUnit !== customRelativeUnit) {
            set({ customRelativeUnit });
          }
        },
        setPerformanceMetrics: (apiTime, backendTime, indexTime) => {
          set({
            apiExecutionTime: apiTime,
            backendLatency: backendTime,
            indexQueryTime: indexTime
          });
        },
        clearSearchQuery: () => {
          set({ searchQuery: '' });
          // Update URL immediately when search query is cleared
          setTimeout(() => {
            const updatedState = get();
            updatedState.updateUrlParams();
          }, 100);
        },
        triggerSearch: () => {
          const currentState = get();
          set({ hasSearched: true });
          
          // Update URL parameters when search is triggered
          currentState.updateUrlParams();
        },
        setRelativeValue: (relativeValue) => {
          const currentState = get();
          if (currentState.relativeValue !== relativeValue) {
            set({ relativeValue });
          }
        },
        updateRelativeValue: () => {
          const currentState = get();
          if (currentState.isRelative) {
            const { startDate, endDate } = calculateRelativeDateRange(
              currentState.relativeValue,
              currentState.customRelativeUnit,
              currentState.customRelativeCount
            );
            
         
            currentState.setUTCTimeSince(startDate);
            currentState.setUTCTimeSinceMs(startDate.getTime());
            currentState.setUTCTimeTo(endDate);
            currentState.setUTCTimeToMs(endDate.getTime());
          }
        },
        setSortBy: (sortBy) => {
          const currentState = get();
          if (currentState.sortBy !== sortBy) {
            set({ sortBy });
          }
        },
        setSortOrder: (sortOrder) => {
          const currentState = get();
          if (currentState.sortOrder !== sortOrder) {
            set({ sortOrder });
          }
        },
        setPageSize: (pageSize) => {
          const currentState = get();
          if (currentState.pageSize !== pageSize) {
            set({ pageSize });
          }
        },  
        setCurrentPage: (currentPage) => {
          const currentState = get();
          if (currentState.currentPage !== currentPage) {
            set({ currentPage });
          }
        },  
        setAvailableColumns: (availableColumns, logs) => {
          const currentState = get();
          //dedup the available columns
          const dedupedAvailableColumns = availableColumns.filter((value, index, self) =>
            self.indexOf(value) === index
          );

          // Initialize selected columns if they're empty
          if (currentState.selectedColumns.length === 0 && dedupedAvailableColumns.length > 0) {
            const mandatoryColumns = currentState.mandatoryColumns;

            // Filter out columns starting with underscore for initial selection
            const visibleColumns = dedupedAvailableColumns.filter(col => !col.startsWith('_'));

            // Populated columns first — empty fields aren't useful as defaults.
            const populationCount = (col: string) => {
              if (!logs || logs.length === 0) return 1;
              let count = 0;
              for (const row of logs) {
                const v = row[col];
                if (v === null || v === undefined) continue;
                if (typeof v === 'string' && (v.trim() === '' || v === '-')) continue;
                count++;
              }
              return count;
            };

            // Rank columns by usefulness to a human reading a log table.
            // Higher priority = shown first / more likely included by default.
            // The previous default leaned on `slice(0,5)` over an alphabetised
            // list, which surfaced `auth`/`ident` (almost always "-") and hid
            // the columns the user actually wants (`status`, `method`, `url`).
            const priority = (col: string): number => {
              const lc = col.toLowerCase();
              if (lc === 'message' || lc === 'msg') return 100;
              if (lc === 'level' || lc === 'severity' || lc === 'log_level') return 95;
              if (lc === 'status' || lc === 'status_code' || lc === 'http_status' || lc === 'response_status') return 90;
              if (lc === 'method' || lc === 'verb' || lc === 'http_method') return 85;
              if (lc === 'url' || lc === 'path' || lc === 'request' || lc === 'uri') return 80;
              if (lc === 'host' || lc === 'hostname') return 75;
              if (lc === 'service' || lc === 'program' || lc === 'app' || lc === 'component') return 70;
              if (lc === 'client_ip' || lc === 'remote_addr' || lc === 'src_ip') return 65;
              if (lc === 'user_agent' || lc === 'agent') return 60;
              if (lc === 'user' || lc === 'user_id' || lc === 'username') return 55;
              if (lc === 'duration' || lc === 'latency' || lc === 'response_time' || lc === 'elapsed') return 50;
              if (lc === 'bytes' || lc === 'size' || lc === 'content_length') return 45;
              if (lc === 'referrer' || lc === 'referer') return 40;
              if (lc === 'auth' || lc === 'ident') return 5; // mostly "-" in apache/nginx logs
              return 30; // generic extracted field
            };

            const ranked = [...visibleColumns]
              .filter(col => !mandatoryColumns.includes(col))
              .map(col => ({ col, score: priority(col), populated: populationCount(col) }))
              // populated columns first, then by score
              .sort((a, b) => {
                const aHas = a.populated > 0 ? 1 : 0;
                const bHas = b.populated > 0 ? 1 : 0;
                if (aHas !== bHas) return bHas - aHas;
                if (b.score !== a.score) return b.score - a.score;
                return a.col.localeCompare(b.col);
              })
              .map(x => x.col);

            const initialSelectedColumns = [
              ...mandatoryColumns,
              ...ranked.slice(0, 6),
            ];

            set({
              availableColumns: dedupedAvailableColumns,
              selectedColumns: initialSelectedColumns
            });
          } else {
            //over ride the available columns with the new ones
            set({ availableColumns: dedupedAvailableColumns });
          }
        },
        setSelectedColumns: (selectedColumns) => {
          const currentState = get();
          // Ensure mandatory columns are always included
          const mandatoryColumns = currentState.mandatoryColumns;
          const newSelectedColumns = [
            ...mandatoryColumns,
            ...selectedColumns.filter(col => !mandatoryColumns.includes(col))
          ];
          
          set({ selectedColumns: newSelectedColumns });
        },
        setColumnWidths: (columnWidths) => {
          set({ columnWidths });
        },
        setColumnLocked: (columnLocked) => {
          set({ isColumnLocked: columnLocked });
        },
        updateColumnWidth: (column, width) => {
          const currentState = get();
          set({ 
            columnWidths: { 
              ...currentState.columnWidths, 
              [column]: width 
            } 
          });
        },
        resetPagination: () => {
          set({ currentPage: 1 });
        },
        
        // URL parameter functions
        syncWithUrlParams: () => {
          if (typeof window === 'undefined') return;
          
          const urlParams = getUrlParams();
          if (!urlParams) return;
          const state = get();
          let shouldTriggerSearch = false;
          
          // Update search query if it exists in URL
          if (urlParams.q !== undefined && urlParams.q !== state.searchQuery) {
            set({ searchQuery: urlParams.q });
            shouldTriggerSearch = true;
          }
          
          // Check if using relative date format
          if (urlParams.isRelative === 'true') {
            if (!state.isRelative) {
              set({ isRelative: true });
              shouldTriggerSearch = true;
            }
            
            // Update relative value if it exists in URL
            if (urlParams.relativeValue !== undefined && urlParams.relativeValue !== state.relativeValue) {
              set({ relativeValue: urlParams.relativeValue });
              shouldTriggerSearch = true;
            }
            
            // Process the relative parameter if it exists
            if (urlParams.relative) {
              const relativeParam = urlParams.relative;
              
              // Check if it's a preset value
              const presetValues = RELATIVE_DATE_PRESETS.map(option => option.value);
              if (presetValues.includes(relativeParam)) {
                if (state.relativeValue !== relativeParam) {
                  set({ relativeValue: relativeParam });
                  shouldTriggerSearch = true;
                }
              } else {
                // Parse custom format: "count-unit-ago"
                const match = relativeParam.match(/^(\d+)-([a-z]+)-ago$/);
                if (match) {
                  const count = parseInt(match[1], 10);
                  const unit = match[2];
                  
                  if (!isNaN(count) && 
                      (state.customRelativeCount !== count || state.customRelativeUnit !== unit || state.relativeValue !== 'custom')) {
                    set({ 
                      relativeValue: 'custom',
                      customRelativeCount: count,
                      customRelativeUnit: unit
                    });
                    shouldTriggerSearch = true;
                  }
                }
              }
              
              // Calculate actual date range based on relative settings
              const now = new Date();
              let startDate: Date;
              
              if (state.relativeValue === 'custom') {
                // Calculate custom relative date
                startDate = calculateRelativeDate(now, state.customRelativeUnit, state.customRelativeCount);
              } else {
                // Calculate preset relative date
                startDate = calculatePresetRelativeDate(now, state.relativeValue);
              }
              
              // Update the time range in the store
              set({
                UTCTimeSince: startDate,
                UTCTimeSinceMs: startDate.getTime(),
                UTCTimeTo: now,
                UTCTimeToMs: now.getTime()
              });
            }
          } else {
            // Using absolute date format with timestamps
            if (state.isRelative) {
              set({ isRelative: false });
            }
            
            // Update time range if it exists in URL
            if (urlParams.since !== undefined) {
              const sinceMs = Number(urlParams.since);
              if (!isNaN(sinceMs) && sinceMs !== state.UTCTimeSinceMs) {
                set({ 
                  UTCTimeSinceMs: sinceMs,
                  UTCTimeSince: new Date(sinceMs)
                });
                shouldTriggerSearch = true;
              }
            }
            
            if (urlParams.to !== undefined) {
              const toMs = Number(urlParams.to);
              if (!isNaN(toMs) && toMs !== state.UTCTimeToMs) {
                set({ 
                  UTCTimeToMs: toMs,
                  UTCTimeTo: new Date(toMs)
                });
                shouldTriggerSearch = true;
              }
            }
          }
          
          // Trigger search if parameters changed
          if (shouldTriggerSearch) {
            set({ isLoading: true, hasSearched: false });
            setTimeout(() => {
              const updatedState = get();
              set({ hasSearched: true, isLoading: false });
            }, 0);
          }
        },
        
        updateUrlParams: () => {
          if (typeof window === 'undefined') return;
          
          const state = get();
          const params = new URLSearchParams();
          
          // Add search query to URL if it exists
          if (state.searchQuery) {
            params.set('q', state.searchQuery);
          }
          
          // Add date parameters to URL
          if (state.isRelative) {
            // For relative dates, use a descriptive format
            params.set('isRelative', 'true');
            params.set('relativeValue', state.relativeValue);
            
            if (state.relativeValue === 'custom') {
              // Format: "count-unit-ago" (e.g., "3-days-ago")
              params.set('relative', `${state.customRelativeCount}-${state.customRelativeUnit}-ago`);
            } else {
              // Use the preset value directly
              params.set('relative', state.relativeValue);
            }
          } else {
            // For absolute dates, use timestamps
            params.set('since', state.UTCTimeSinceMs.toString());
            params.set('to', state.UTCTimeToMs.toString());
          }
          
          // Update URL without reloading the page, using hash-based routing
          const url = `${window.location.pathname}#?${params.toString()}`;
          window.history.pushState({ 
            searchQuery: state.searchQuery,
            isRelative: state.isRelative,
            relativeValue: state.relativeValue,
            customRelativeCount: state.customRelativeCount,
            customRelativeUnit: state.customRelativeUnit,
            since: state.UTCTimeSinceMs,
            to: state.UTCTimeToMs
          }, '', url);
        },
        
        resetStore: () => {
          set({
            firstLoad: true,
            searchQuery: '',
            sources: [],
            dirty: false,
            isLoading: false,
            isRelative: true,
            relativeValue: 'last-10-years',
            customRelativeCount: 10,
            customRelativeUnit: 'years',
            resultCount: 0,
            resultQueryLatency: 0,
            resultReceviedOn: new Date(),
            UTCTimeSince: new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000),
            UTCTimeTo: new Date(),
            UTCTimeSinceMs: Date.now() - 10 * 365 * 24 * 60 * 60 * 1000,
            UTCTimeToMs: Date.now(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            hasSearched: false, 
            sortBy: 'timestamp',
            sortOrder: 'desc',
            pageSize: 100,
            currentPage: 1,
            availableColumns: [],
            selectedColumns: [],  
            mandatoryColumns: ['timestamp'],
            columnWidths: {},
            isColumnLocked: false,
          });
        },
      };
    },
    {
      name: 'logsonic-search-query-params', // name for localStorage
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        ...state,
        // Convert Date objects to ISO strings for storage
        UTCTimeSince: state.UTCTimeSince.toISOString(),
        UTCTimeTo: state.UTCTimeTo.toISOString(),
        resultReceviedOn: state.resultReceviedOn.toISOString(),
        // Include the timestamp values
        UTCTimeSinceMs: state.UTCTimeSinceMs,
        UTCTimeToMs: state.UTCTimeToMs,
        hasSearched: state.hasSearched,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        pageSize: state.pageSize,
        selectedColumns: state.selectedColumns,
        mandatoryColumns: state.mandatoryColumns,
        columnWidths: state.columnWidths,
      }),
      onRehydrateStorage: () => (state) => {
        // Convert ISO strings back to Date objects when rehydrating
        if (state) {
          state.UTCTimeSince = ensureDate(state.UTCTimeSince);
          state.UTCTimeTo = ensureDate(state.UTCTimeTo);
          state.resultReceviedOn = ensureDate(state.resultReceviedOn);
          
          // Ensure timestamp values are set
          if (!state.UTCTimeSinceMs) {
            state.UTCTimeSinceMs = state.UTCTimeSince.getTime();
          }
          if (!state.UTCTimeToMs) {
            state.UTCTimeToMs = state.UTCTimeTo.getTime();
          }
          

          const store = useSearchQueryParamsStore.getState();
          store.syncWithUrlParams();
        }
      },
    }
  )
);

// Initialize URL parameters if not present
if (typeof window !== 'undefined') {
  const initialUrlParams = getUrlParams();
  if (!initialUrlParams || Object.keys(initialUrlParams).length === 0) {
    // If no URL parameters, set them based on current store state
    setTimeout(() => {
      const store = useSearchQueryParamsStore.getState();
      store.updateUrlParams();
    }, 0);
  } else {
    // If URL parameters exist, make sure they're properly applied to the store
    // This ensures the search UI components reflect the URL state.
    // BUT: a stale `q` from a previous session can show "Query: error" next to
    // an empty index and look like a broken page. We strip it once on the
    // landing route (`#?…` only, before any sub-route) — that's the cold-load
    // case where we know the user just opened the app fresh.
    const isLandingHash =
      typeof window.location.hash === 'string' &&
      window.location.hash.startsWith('#?');
    setTimeout(() => {
      const store = useSearchQueryParamsStore.getState();
      if (isLandingHash && initialUrlParams.q) {
        // Defer the clear until after the system info comes back so we don't
        // wipe a perfectly valid pre-filled query on a populated index. The
        // StatusBar listens to systemInfo independently; we just need to know
        // whether storage is empty *at load*.
        import('@/lib/api-client').then(({ getSystemInfo }) => {
          getSystemInfo(true).then(info => {
            const empty = (info?.storage_info?.total_log_entries ?? 0) === 0;
            if (empty) {
              const s = useSearchQueryParamsStore.getState();
              if (s.searchQuery) s.clearSearchQuery();
            } else {
              store.syncWithUrlParams();
              store.triggerSearch();
            }
          }).catch(() => {
            // If system info fails, fall back to old behavior — don't strip.
            store.syncWithUrlParams();
            if (initialUrlParams.q) store.triggerSearch();
          });
        });
        return;
      }
      store.syncWithUrlParams();

      // After syncing, trigger a search if there's a query
      if (initialUrlParams.q) {
        store.triggerSearch();
      }
    }, 0);
  }
}

export default useSearchQueryParamsStore; 