import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { AIQueryDialog } from "@/components/Home/AIQueryDialog";
import { useToast } from "@/components/ui/use-toast";
import { useSearchLogs } from "@/hooks/useSearchLogs";
import { getLogs } from "@/lib/api-client";
import { calculateRelativeDateRange } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { checkAIStatus } from "@/services/aiService";
import { useLogResultStore } from "@/stores/useLogResultStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { ArrowRight, Download, HelpCircle, Loader2, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PerformanceMetricsPopover } from "./PerformanceMetricsPopover";
import { QueryHelperPopover } from "./QueryHelperPopover";

// Cap exports so we don't churn the browser on huge result sets; the user
// is warned via toast if matches exceed this.
const EXPORT_MAX_ROWS = 100_000;

const GhostBtn = ({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center transition-colors"
    style={{
      gap: 6,
      height: 24,
      padding: '0 8px',
      borderRadius: 5,
      fontSize: 12,
      fontWeight: 500,
      background: 'transparent',
      color: 'var(--ls-text-2)',
      border: '1px solid transparent',
      cursor: 'pointer',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = 'var(--ls-bg-2)';
      e.currentTarget.style.color = 'var(--ls-text)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = 'transparent';
      e.currentTarget.style.color = 'var(--ls-text-2)';
    }}
  >
    {icon}
    <span>{children}</span>
  </button>
);

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
  const [isExporting, setIsExporting] = useState(false);
  const { toast } = useToast();
  
  // AI query related state
  const [isAIDialogOpen, setIsAIDialogOpen] = useState(false);
  const [isAIAvailable, setIsAIAvailable] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Click-to-filter: when a cell in the log table dispatches a custom event,
  // append `field:"value"` (or `-field:"value"`) to the search query and run
  // the search. Kept as a window event so we don't have to thread the store
  // through the table render path.
  useEffect(() => {
    const onAddFilter = (e: Event) => {
      const ce = e as CustomEvent<{ field: string; value: string; exclude?: boolean }>;
      const { field, value, exclude } = ce.detail || {} as any;
      if (!field || value === undefined || value === null) return;
      // Quote the value if it contains whitespace or special chars Bleve cares about.
      const needsQuote = /[\s:"]/.test(String(value));
      const formatted = `${exclude ? '-' : ''}${field}:${needsQuote ? `"${String(value).replace(/"/g, '\\"')}"` : value}`;
      // Avoid duplicate clauses: skip if the exact token is already in the query.
      const current = (store.searchQuery || '').trim();
      if (current.split(/\s+/).includes(formatted)) return;
      const next = current ? `${current} ${formatted}` : formatted;
      setLocalSearchQuery(next);
      store.setSearchQuery(next);
      store.resetPagination();
      // Defer the actual fetch so the store update lands first.
      setTimeout(() => { searchLogs(); }, 0);
    };
    window.addEventListener('logsonic:add-filter', onAddFilter);
    return () => window.removeEventListener('logsonic:add-filter', onAddFilter);
  }, [store, searchLogs]);

  // Global keyboard shortcut: `/` or Cmd/Ctrl+K focuses the search input.
  // Skip when the user is already typing in an input/textarea/contenteditable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      const slash = e.key === '/' && !isEditable;

      if (cmdK || slash) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);


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
    } else if (e.key === "Escape") {
      // Match the behavior of most editor-style apps: Escape releases focus.
      inputRef.current?.blur();
    }
  }, [handleSearch]);

  // Export all rows matching the current query (not just the visible page).
  // The old behavior dumped only the current page silently, which was lossy.
  const handleExport = useCallback(async () => {
    const totalCount = store.resultCount;
    if (totalCount === 0) {
      toast({
        title: 'Nothing to export',
        description: 'Run a search that returns at least one row.',
        variant: 'default',
      });
      return;
    }

    setIsExporting(true);
    try {
      // Resolve the active time range — mirrors useSearchLogs so relative
      // ranges aren't snapshotted to a stale value.
      let startDate = store.UTCTimeSince;
      let endDate = store.UTCTimeTo;
      if (store.isRelative) {
        const r = calculateRelativeDateRange(
          store.relativeValue,
          store.customRelativeUnit,
          store.customRelativeCount,
        );
        startDate = r.startDate;
        endDate = r.endDate;
      }

      const cappedAt = Math.min(totalCount, EXPORT_MAX_ROWS);
      const result = await getLogs({
        query: store.searchQuery,
        _src: store.sources.length > 0 ? store.sources.join(',') : undefined,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        limit: cappedAt,
        offset: 0,
        sort_by: store.sortBy,
        sort_order: store.sortOrder,
      });

      const logs = result?.logs ?? [];
      if (logs.length === 0) {
        toast({
          title: 'Export failed',
          description: 'Backend returned no rows for this query.',
          variant: 'destructive',
        });
        return;
      }

      const jsonl = logs.map(log => JSON.stringify(log)).join('\n') + '\n';
      const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `logsonic-export-${ts}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (totalCount > EXPORT_MAX_ROWS) {
        toast({
          title: `Exported first ${EXPORT_MAX_ROWS.toLocaleString()} of ${totalCount.toLocaleString()} rows`,
          description: 'Narrow the time range or query to export the remainder.',
          variant: 'default',
        });
      } else {
        toast({
          title: `Exported ${logs.length.toLocaleString()} rows`,
          variant: 'default',
        });
      }
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  }, [
    store.resultCount,
    store.searchQuery,
    store.sources,
    store.isRelative,
    store.relativeValue,
    store.customRelativeCount,
    store.customRelativeUnit,
    store.UTCTimeSince,
    store.UTCTimeTo,
    store.sortBy,
    store.sortOrder,
    toast,
  ]);

  // Insert a hint snippet into the search input and focus it so the user
  // can keep typing without a second click.
  const handleHintInsert = useCallback((insert: string) => {
    const cleaned = insert.replace('$CURSOR$', '').replace('$FIELD$', '');
    const newQuery = localSearchQuery ? `${localSearchQuery.trimEnd()} ${cleaned}` : cleaned;
    setLocalSearchQuery(newQuery);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [localSearchQuery]);

  // Insert a column-based field: hint and refocus the input for chained typing.
  const handleColumnHint = useCallback((column: string) => {
    const insert = `${column}:`;
    const newQuery = localSearchQuery ? `${localSearchQuery.trimEnd()} ${insert}` : insert;
    setLocalSearchQuery(newQuery);
    setTimeout(() => inputRef.current?.focus(), 0);
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
                    size={16}
                    className="cursor-pointer"
                    style={{
                      color: 'var(--ls-accent)',
                      filter: 'drop-shadow(0 0 4px rgba(107, 77, 242, 0.5))',
                      animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                    }}
                  />
                </button>
              ) : (
                <Search size={16} style={{ color: 'var(--ls-text-3)' }} className="pointer-events-none" />
              )}
            </div>

            <Input
              ref={inputRef}
              type="text"
              value={localSearchQuery}
              onChange={handleInputChange}
              placeholder={isInputFocused
                ? 'Try level:error or "connection timeout"'
                : 'Search logs… (/ or ⌘K)'}
              className={cn(
                "w-full pl-10 pr-10 text-sm rounded-md shadow-sm focus-visible:ring-2 focus-visible:ring-offset-0",
                "focus-visible:ring-[var(--ls-accent-softer)] focus-visible:border-[var(--ls-accent)]",
                isInputFocused && "border-[var(--ls-accent)]"
              )}
              style={{
                height: 36,
                fontFamily: 'var(--ls-font-mono)',
                fontSize: 12.5,
                background: 'var(--ls-bg-1)',
                borderColor: 'var(--ls-border-strong)',
                color: 'var(--ls-text)',
              }}
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
            <div
              className="flex h-[36px] rounded-md overflow-hidden"
              style={{
                border: '1px solid var(--ls-border-strong)',
                background: 'var(--ls-bg-1)',
              }}
            >
              <DateTimeRangeButton />

              <span aria-hidden style={{ width: 1, background: 'var(--ls-border-strong)' }} />

              <Button
                onClick={() => handleSearch(true)}
                className="h-full px-4 rounded-none text-white"
                style={{
                  background: 'var(--ls-accent)',
                  fontWeight: 600,
                  fontSize: 12.5,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ls-accent-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--ls-accent)')}
                disabled={isLoading}
              >
                <span className="hidden sm:inline mr-1.5">{isLoading ? 'Searching…' : 'Search'}</span>
                <ArrowRight size={14} />
              </Button>
            </div>
          </div>
        </div>
        
        {/* Inline syntax hints - appear when input is focused */}
        {showHints && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 animate-in fade-in duration-150">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider mr-0.5"
              style={{ color: 'var(--ls-text-3)' }}
            >
              Syntax:
            </span>
            {SYNTAX_HINTS.map((hint) => (
              <button
                key={hint.label}
                type="button"
                onClick={() => handleHintInsert(hint.insert)}
                title={hint.description}
                className="inline-flex items-center px-2 py-0.5 transition-colors"
                style={{
                  borderRadius: 4,
                  border: '1px solid var(--ls-border)',
                  background: 'var(--ls-bg-1)',
                  fontFamily: 'var(--ls-font-mono)',
                  fontSize: 11,
                  color: 'var(--ls-text-2)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--ls-accent)';
                  e.currentTarget.style.color = 'var(--ls-accent-text)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--ls-border)';
                  e.currentTarget.style.color = 'var(--ls-text-2)';
                }}
              >
                {hint.label}
              </button>
            ))}
            {columnHints.length > 0 && (
              <>
                <span style={{ color: 'var(--ls-text-4)' }} className="mx-0.5">|</span>
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider mr-0.5"
                  style={{ color: 'var(--ls-text-3)' }}
                >
                  Fields:
                </span>
                {columnHints.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => handleColumnHint(col)}
                    title={`Search in field: ${col}`}
                    className="inline-flex items-center px-2 py-0.5 transition-colors"
                    style={{
                      borderRadius: 4,
                      border: '1px solid var(--ls-accent-border)',
                      background: 'var(--ls-accent-softer)',
                      fontFamily: 'var(--ls-font-mono)',
                      fontSize: 11,
                      color: 'var(--ls-accent-text)',
                    }}
                  >
                    {col}:
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Search metadata display */}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground px-1">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <QueryHelperPopover trigger={
              <Button
                variant="link"
                className="text-xs h-auto p-0 gap-1"
                style={{ color: 'var(--ls-text-3)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ls-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ls-text-3)')}
              >
                <HelpCircle className="h-3 w-3" />
                Search Help
              </Button>
            } />

            {store.searchQuery && (
              <span className="flex items-center gap-1">
                <span className="ls-meta-label">Query:</span>
                <span className="ls-chip ls-chip-warn ls-chip-mono">
                  {store.searchQuery}
                </span>
                <span className="ls-sep">·</span>
              </span>
            )}

            {store.lastSearchStart && store.lastSearchEnd && (
              <span className="flex items-center gap-1">
                <span className="ls-meta-label">Range:</span>
                <span className="ls-chip ls-chip-neutral">
                  {store.lastSearchStart.toLocaleString()} – {store.lastSearchEnd.toLocaleString()}
                  <span className="ls-chip-sub ml-1">({store.timeZone})</span>
                </span>
              </span>
            )}

            {/* Performance metrics popover */}
            <PerformanceMetricsPopover
              apiExecutionTime={apiExecutionTime}
            />
          </div>

          <div className="flex flex-shrink-0 items-center">
            <GhostBtn
              icon={isExporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              onClick={isExporting ? undefined : handleExport}
            >
              {isExporting ? 'Exporting…' : 'Export'}
            </GhostBtn>
          </div>
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