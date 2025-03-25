import { useEffect, useRef } from 'react';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { Card } from '@/components/ui/card';
import { PaginationControls } from '../PaginationControls';
import { LogViewerHeader } from './LogViewerHeader';
import { LogViewerTable } from './LogViewerTable';
import { useSearchLogs } from '@/hooks/useSearchLogs';

// Define the interface for the LogViewerTable ref
interface LogViewerTableRef {
  autofitColumns: () => void;
}

type SearchParamType = {
  query: string;
  pageSize: number;
  currentPage: number;
  since: number;
  to: number;
  sortBy: string;
  sortOrder: string;
  sources: string[];
}
/**
 * Main LogViewer component
 */
export const LogViewer = () => {
  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();
  
  // Use the search logs hook
  const { searchLogs } = useSearchLogs();
  
  // Flag to track if this is the initial search
  const firstTimeLoadSearchRef = useRef(true);
  
  // Create a ref to access the LogViewerTable's autofitColumns function
  const logViewerTableRef = useRef<LogViewerTableRef>(null);
  
  // Use refs to track the previous search parameters to avoid unnecessary refreshes
  const prevSearchParamsRef = useRef<SearchParamType>({
    query: store.searchQuery,
    pageSize: store.pageSize,
    currentPage: store.currentPage,
    since: store.UTCTimeSinceMs,
    to: store.UTCTimeToMs,
    sortBy: store.sortBy,
    sortOrder: store.sortOrder,
    sources: store.sources
  });

  // Fetch logs when search parameters change (excluding date changes)
  useEffect(() => {
    if (!store.hasSearched) return;
    
    // Check if search parameters have actually changed
    const currentParams: SearchParamType = {
      query: store.searchQuery,
      pageSize: store.pageSize,
      currentPage: store.currentPage,
      since: store.UTCTimeSinceMs,
      to: store.UTCTimeToMs,
      sortBy: store.sortBy,
      sortOrder: store.sortOrder,
      sources: store.sources
    };
    
    const prevParams = prevSearchParamsRef.current;
    
    // Only search if parameters have changed or this is the initial search
    // Note: We're not checking date changes here

    
    const shouldSearch =  Object.entries(currentParams).some(([key, value]) => {
      if (prevParams[key as keyof typeof prevParams] === undefined) {
        return false;
      }
      // Stringify to compare arrays and objects
      if (JSON.stringify(prevParams[key as keyof typeof prevParams]) != JSON.stringify(value)) {
        console.log("Search triggered due to changed" , key, prevParams[key as keyof typeof prevParams], "=>", value  );
        return true;
      }
      return false;
    }) || firstTimeLoadSearchRef.current;


    if (shouldSearch) {
      // Update the previous parameters
      prevSearchParamsRef.current = currentParams;
      firstTimeLoadSearchRef.current = false;
      
      // Execute the search
      searchLogs();
    }
  }, [
    store.hasSearched, 
    store.searchQuery, 
    store.pageSize, 
    store.currentPage, 

    store.UTCTimeSinceMs,
    store.UTCTimeToMs,
    store.sortBy, 
    store.sortOrder,
    store.sources,
   
  ]);

  // Handle page change
  const handlePageChange = (page: number) => {
    store.setCurrentPage(page);
  };

  // Handle page size change
  const handlePageSizeChange = (size: number) => {
    store.setPageSize(size);
  };

  // Function to trigger autofitColumns on the LogViewerTable
  const handleAutofitColumns = () => {
    if (logViewerTableRef.current) {
      logViewerTableRef.current.autofitColumns();
    }
  };

  return (
    <Card className="border-0 shadow-none h-full flex flex-col">
      <LogViewerHeader autofitColumns={handleAutofitColumns} />
      <div className="flex-1 overflow-auto">
        <LogViewerTable ref={logViewerTableRef} />
      </div>
      
      <div className="border-t p-2 sticky bottom-0 bg-white">
        <PaginationControls
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          pageSizeOptions={[10, 25, 50, 100, 250, 1000]}
        />
      </div>
    </Card>
  );
};

export default LogViewer; 