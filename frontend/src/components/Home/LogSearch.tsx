import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { AIQueryDialog } from "@/components/Home/AIQueryDialog";
import { useSearchLogs } from "@/hooks/useSearchLogs";
import { cn } from "@/lib/utils";
import { checkAIStatus } from "@/services/aiService";
import { useLogResultStore } from "@/stores/useLogResultStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { ArrowRight, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PerformanceMetricsPopover } from "./PerformanceMetricsPopover";
import { QueryHelperPopover } from "./QueryHelperPopover";

// Log Search component renders and updates the SearchQueryParamsStoreState
// this includes search query and date range. 
export const LogSearch = ({ 
    onSearchComplete // optional callback for the caller to get notifications when the search is complete
  }: {
    onSearchComplete?: (data: any) => void;
  }) => {

  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();
  
  const { searchLogs } = useSearchLogs(onSearchComplete);
  const { isLoading } = useLogResultStore();
  const [localSearchQuery, setLocalSearchQuery] = useState(store.searchQuery);
  
  // AI query related state
  const [isAIDialogOpen, setIsAIDialogOpen] = useState(false);
  const [isAIAvailable, setIsAIAvailable] = useState(false);


  // Check if AI/Ollama is running
  useEffect(() => {
    const checkAI = async () => {
      const status = await checkAIStatus();
      // Check if Ollama is running and any logsonic-related model is available
      // This will match "logsonic", "logsonic:latest", "logsonic-search", etc.
      const hasLogsonicModel = status.ollama_running && 
        status.models_available.some(model => 
          model.toLowerCase().includes('logsonic')
        );
      
      setIsAIAvailable(hasLogsonicModel);
    };
    
    // Check AI status once on component mount
    checkAI();
    
    // No interval checking - only check when component loads
  }, []);

  useEffect(() => { 
    setLocalSearchQuery(store.searchQuery);
  }, [store.searchQuery]);

  // Handle input change without immediately updating the store
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSearchQuery(e.target.value);
  }, []);

  const handleSearch = useCallback((force: boolean = false) => {
    store.resetPagination();
    store.setSearchQuery(localSearchQuery);

    if (force) {
      searchLogs();
    }
  }, [localSearchQuery, searchLogs, store]);

  const handleClearSearch = useCallback(() => {
    setLocalSearchQuery('');
    store.clearSearchQuery();

    store.resetPagination();
  }, [store]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  }, [handleSearch]);

  // Get performance metrics from the store
  const apiExecutionTime = store.apiExecutionTime;

  return (
    <div className="flex flex-col space-y-4">
      {/* Professional integrated search bar */}
      <div className="flex flex-col space-y-2">
        <div className="flex items-center w-full gap-2">
          {/* Search input with clear button */}
          <div className="relative flex-grow">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3">
              {isAIAvailable ? (
                <button
                  type="button"
                  onClick={() => setIsAIDialogOpen(true)}
                  className="focus:outline-none"
                  aria-label="Use AI to build query"
                  title="Use AI to build query"
                >
                  <Sparkles 
                    size={18} 
                    className="text-blue-500 hover:text-blue-600 cursor-pointer"
                    style={{
                      filter: 'drop-shadow(0 0 4px rgba(139, 92, 246, 0.5))',
                      animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
                    }}
                  />
                </button>
              ) : (
                <Search size={18} className="text-gray-400 pointer-events-none" />
              )}
            </div>
            
            <Input 
              type="text" 
              value={localSearchQuery} 
              onChange={handleInputChange} 
              placeholder="Search logs..."
              className={cn(
                "w-full pl-10 pr-10 py-6 text-base rounded-lg border border-gray-300 shadow-sm focus-visible:ring-2",
                "focus-visible:ring-offset-0 focus-visible:ring-blue-500/40 focus-visible:border-blue-500"
              )}
              onKeyDown={handleKeyDown}
            />
            
            {/* Remove AI Query Button and keep only the clear search button */}
            {localSearchQuery && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 inset-y-0 h-full flex items-center justify-center focus:outline-none"
                aria-label="Clear search"
                title="Clear search"
              >
                <div className="h-6 w-6 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center transition-colors">
                  <X size={14} className="text-gray-600" />
                </div>
              </button>
            )}
          </div>
          
          {/* Merged date range and search panel button */}
          <div className="flex-shrink-0">
            <div className="flex h-[50px] rounded-lg overflow-hidden border border-gray-300 shadow-sm">
              <DateTimeRangeButton />
              
              <Button 
                onClick={() => handleSearch(true)}
                className="h-full px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-none"
                disabled={isLoading}
              >
                <span className="hidden sm:inline mr-1">{isLoading ? 'Searching...' : 'Search'}</span>
                <ArrowRight size={16} />
              </Button>
            </div>
          </div>
        </div>
        
        {/* Search metadata display */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground px-1">
          <QueryHelperPopover trigger={<Button variant="link" className="text-blue-500 hover:text-blue-600">Search Help</Button>} />

          {store.sources.length > 0 && (
              <>
                <span className="font-medium text-gray-700">Sources:</span>
                <span className="bg-gray-100 px-2 py-0.5 rounded-md text-gray-800">
                  {store.sources.join(", ")} 
                </span>
                <span className="mx-1 text-gray-400">|</span>
              </>
            )}
            {store.searchQuery && (
              <>
                <span className="font-medium text-gray-700"> Query:</span> 
                <span className="bg-gray-100 px-2 py-0.5 rounded-md text-gray-800">
                  {store.searchQuery}
                </span>
                <span className="mx-1 text-gray-400">|</span>
              </>
            )}

            {store.lastSearchStart && store.lastSearchEnd && (
              <>
                <span className="font-medium text-gray-700">Search Time Range:</span>
                <span className="bg-gray-100 px-2 py-0.5 rounded-md text-gray-800">
                  {`${store.lastSearchStart.toLocaleString()} - ${store.lastSearchEnd.toLocaleString()} (${store.timeZone})`}
                </span>
              </>
            )}

            {/* Performance metrics popover */}
            <PerformanceMetricsPopover 
              apiExecutionTime={apiExecutionTime} 
            />
        </div>
      </div>

      {/* AI Query Dialog */}
      <AIQueryDialog 
        open={isAIDialogOpen}
        onOpenChange={setIsAIDialogOpen}

      />
    </div>
  );
};

export default LogSearch;