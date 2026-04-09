import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { AIQueryDialog } from "@/components/Home/AIQueryDialog";
import { useSearchLogs } from "@/hooks/useSearchLogs";
import { cn } from "@/lib/utils";
import { checkAIStatus } from "@/services/aiService";
import { useLogResultStore } from "@/stores/useLogResultStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { ArrowRight, HelpCircle, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PerformanceMetricsPopover } from "./PerformanceMetricsPopover";
import { QueryHelperPopover } from "./QueryHelperPopover";

// Syntax hint chips shown below the search bar when focused
const SYNTAX_HINTS = [
  { label: '"exact phrase"', insert: '"$CURSOR$"', description: 'Exact phrase match' },
  { label: 'field:value', insert: '$FIELD$:', description: 'Search in specific field' },
  { label: '+required', insert: '+', description: 'Term must be present (AND)' },
  { label: '-excluded', insert: '-', description: 'Term must not be present' },
  { label: '/regex/', insert: '/$CURSOR$/', description: 'Regular expression match' },
  { label: 'status:>400', insert: 'status:>', description: 'Numeric comparison' },
];

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
  const [isInputFocused, setIsInputFocused] = useState(false);


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

  // Insert a hint snippet into the search input
  const handleHintInsert = useCallback((insert: string) => {
    const cursorPos = insert.indexOf('$CURSOR$');
    const cleaned = insert.replace('$CURSOR$', '').replace('$FIELD$', '');
    const newQuery = localSearchQuery ? `${localSearchQuery.trimEnd()} ${cleaned}` : cleaned;
    setLocalSearchQuery(newQuery);
  }, [localSearchQuery]);

  // Insert a column-based field: hint
  const handleColumnHint = useCallback((column: string) => {
    const insert = `${column}:`;
    const newQuery = localSearchQuery ? `${localSearchQuery.trimEnd()} ${insert}` : insert;
    setLocalSearchQuery(newQuery);
  }, [localSearchQuery]);

  // Get columns that could be used as field hints (exclude utility/internal columns)
  const columnHints = useMemo(() => {
    return store.availableColumns
      .filter(c => c !== '_raw' && c !== '_src' && c !== 'select' && c !== 'expander')
      .slice(0, 6); // Show at most 6 column suggestions
  }, [store.availableColumns]);

  // Show hints when input focused or has content (but not when loading)
  const showHints = (isInputFocused || localSearchQuery.length > 0) && !isLoading;

  // Get performance metrics from the store
  const apiExecutionTime = store.apiExecutionTime;

  return (
    <div className="flex flex-col space-y-2">
      {/* Search bar */}
      <div className="flex flex-col space-y-1.5">
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
              placeholder="Search logs… try level:error or &quot;connection timeout&quot;"
              className={cn(
                "w-full pl-10 pr-10 py-5 text-sm rounded-lg border border-gray-300 shadow-sm focus-visible:ring-2",
                "focus-visible:ring-offset-0 focus-visible:ring-blue-500/40 focus-visible:border-blue-500",
                isInputFocused && "border-blue-400"
              )}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setTimeout(() => setIsInputFocused(false), 150)}
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
        
        {/* Inline syntax hints - appear when input is focused */}
        {showHints && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 animate-in fade-in duration-150">
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide mr-0.5">Syntax:</span>
            {SYNTAX_HINTS.map((hint) => (
              <button
                key={hint.label}
                type="button"
                onClick={() => handleHintInsert(hint.insert)}
                title={hint.description}
                className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-[11px] font-mono text-slate-600 border border-slate-200 hover:border-blue-200 transition-colors"
              >
                {hint.label}
              </button>
            ))}
            {columnHints.length > 0 && (
              <>
                <span className="text-[10px] text-slate-300 mx-0.5">|</span>
                <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide mr-0.5">Fields:</span>
                {columnHints.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => handleColumnHint(col)}
                    title={`Search in field: ${col}`}
                    className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-50 hover:bg-blue-100 text-[11px] font-mono text-blue-600 border border-blue-100 hover:border-blue-300 transition-colors"
                  >
                    {col}:
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Search metadata display */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground px-1">
          <QueryHelperPopover trigger={
            <Button variant="link" className="text-slate-400 hover:text-blue-600 text-xs h-auto p-0 gap-1">
              <HelpCircle className="h-3 w-3" />
              Search Help
            </Button>
          } />

          {store.sources.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">Sources:</span>
              {store.sources.map(s => (
                <span key={s} className="bg-blue-50 text-blue-700 border border-blue-100 px-1.5 py-0.5 rounded text-[11px] font-medium">
                  {s}
                </span>
              ))}
              <span className="text-slate-300 mx-0.5">·</span>
            </span>
          )}
          {store.searchQuery && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">Query:</span>
              <span className="bg-amber-50 text-amber-800 border border-amber-100 px-1.5 py-0.5 rounded text-[11px] font-mono">
                {store.searchQuery}
              </span>
              <span className="text-slate-300 mx-0.5">·</span>
            </span>
          )}

          {store.lastSearchStart && store.lastSearchEnd && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">Range:</span>
              <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[11px]">
                {store.lastSearchStart.toLocaleString()} – {store.lastSearchEnd.toLocaleString()}
                <span className="text-slate-400 ml-1">({store.timeZone})</span>
              </span>
            </span>
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