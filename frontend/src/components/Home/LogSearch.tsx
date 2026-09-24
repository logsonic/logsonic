import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { useQueryHistoryRecall } from "@/hooks/useQueryHistoryRecall";
import type { LogResponse, WorkspaceTime } from "@/lib/api-types";
import { applySynonymSuggestion, findSynonymSuggestions } from "@/lib/search-synonyms";
import { cn } from "@/lib/utils";
import { applyWorkspaceTimeToSearchState, searchStateToWorkspaceTime } from "@/lib/workspace-utils";
import { useLogResultStore } from "@/stores/useLogResultStore";
import type { QueryHistoryEntry } from "@/stores/useQueryHistoryStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { ArrowRight, HelpCircle, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PerformanceMetricsPopover } from "./PerformanceMetricsPopover";
import { QueryHelperPopover } from "./QueryHelperPopover";
import { SavedQueriesMenu } from "./SavedQueriesMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";

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
    onSearchComplete: _onSearchComplete // reserved for callers that need search completion notifications
  }: {
    onSearchComplete?: (data: LogResponse) => void;
  }) => {

  // Get the store directly using the hook
  const store = useSearchQueryParamsStore();

  const { isLoading } = useLogResultStore();
  const [localSearchQuery, setLocalSearchQuery] = useState(store.searchQuery);
  
  const [isInputFocused, setIsInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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


  useEffect(() => {
    setLocalSearchQuery(store.searchQuery);
  }, [store.searchQuery]);

  // Handle input change without immediately updating the store
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSearchQuery(e.target.value);
  }, []);

  // ↑/↓ shell-style history recall (spec now-03). Recalling restores the
  // full search context (query + time + sources), not just the input text
  // -- but does not execute a search; Enter/Search still does that, the
  // same as normal typing.
  const handleRecallContext = useCallback((entry: QueryHistoryEntry) => {
    const search = useSearchQueryParamsStore.getState();
    search.setSources(entry.sources ?? []);
    useSearchQueryParamsStore.setState(applyWorkspaceTimeToSearchState(entry.time, search));
  }, []);

  // What time/sources looked like before a recall session started, so
  // cancelling it (Esc, or ↓ past the newest entry) restores them -- a
  // recall session changes context as a preview, not a commit.
  const preRecallContextRef = useRef<{ time: WorkspaceTime; sources: string[] } | null>(null);
  const handleRecallSessionStart = useCallback(() => {
    const search = useSearchQueryParamsStore.getState();
    preRecallContextRef.current = {
      time: searchStateToWorkspaceTime(search),
      sources: [...search.sources],
    };
  }, []);
  const handleRecallSessionEnd = useCallback(() => {
    const captured = preRecallContextRef.current;
    if (!captured) return;
    preRecallContextRef.current = null;
    const search = useSearchQueryParamsStore.getState();
    search.setSources(captured.sources);
    useSearchQueryParamsStore.setState(applyWorkspaceTimeToSearchState(captured.time, search));
  }, []);

  const recall = useQueryHistoryRecall(
    localSearchQuery,
    setLocalSearchQuery,
    handleRecallContext,
    handleRecallSessionStart,
    handleRecallSessionEnd
  );

  const handleSearch = useCallback(() => {
    store.resetPagination();
    store.setSearchQuery(localSearchQuery);
    store.triggerSearch();
    recall.reset();
  }, [localSearchQuery, store, recall]);

  const handleClearSearch = useCallback(() => {
    setLocalSearchQuery('');
    store.clearSearchQuery();

    store.resetPagination();
    recall.reset();
  }, [store, recall]);

  // Applying a saved query or a history entry from the dropdown is a
  // deliberate click, not passive ↑/↓ browsing -- unlike recall, it runs
  // the search immediately (spec now-03 step 5: "click = apply").
  const handleApplyEntry = useCallback((query: string, time?: WorkspaceTime, sources?: string[]) => {
    setLocalSearchQuery(query);
    const search = useSearchQueryParamsStore.getState();
    search.setSources(sources ?? []);
    useSearchQueryParamsStore.setState(applyWorkspaceTimeToSearchState(time, search));
    search.resetPagination();
    search.setSearchQuery(query);
    search.triggerSearch();
    recall.reset();
  }, [recall]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    recall.onKeyDown(e);
    if (e.defaultPrevented) return;

    if (e.key === "Enter") {
      handleSearch();
    } else if (e.key === "Escape") {
      // Match the behavior of most editor-style apps: Escape releases focus.
      inputRef.current?.blur();
    }
  }, [handleSearch, recall]);

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

  // Synonym suggestions for the terms already typed: "error" offers
  // "exception", "fatal"… Purely a prompt -- the dictionary is static and the
  // query is only rewritten when the user clicks a chip.
  const synonymSuggestions = useMemo(
    () => findSynonymSuggestions(localSearchQuery),
    [localSearchQuery]
  );

  // Clicking a suggestion appends its term and refocuses, matching the syntax
  // hints: it composes the query, it does not run the search.
  const handleSynonymInsert = useCallback((term: string) => {
    const suggestion = synonymSuggestions.find((s) => s.term === term);
    if (!suggestion) return;
    setLocalSearchQuery((current) => applySynonymSuggestion(current, suggestion));
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [synonymSuggestions]);

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
              <Search size={16} style={{ color: 'var(--ls-text-3)' }} className="pointer-events-none" />
            </div>

            <Input
              ref={inputRef}
              type="text"
              aria-label="Search logs"
              value={localSearchQuery}
              onChange={handleInputChange}
              placeholder={isInputFocused
                ? 'Try level:error or "connection timeout"'
                : 'Search logs… (/ or ⌘K)'}
              className={cn(
                "w-full pl-10 pr-20 text-sm rounded-md shadow-sm focus-visible:ring-2 focus-visible:ring-offset-0",
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
            
            <div className="absolute right-1.5 inset-y-0 flex items-center gap-0.5">
              <SavedQueriesMenu currentQuery={localSearchQuery} onApply={handleApplyEntry} />
              {localSearchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="h-full flex items-center justify-center focus:outline-none"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <div className="h-6 w-6 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center transition-colors">
                    <X size={14} className="text-gray-600" />
                  </div>
                </button>
              )}
            </div>
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
                onClick={handleSearch}
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

        {/* Synonym suggestions - related terms for what the user has typed */}
        {showHints && synonymSuggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 animate-in fade-in duration-150">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider mr-0.5"
              style={{ color: 'var(--ls-text-3)' }}
            >
              Also search:
            </span>
            {synonymSuggestions.map((suggestion) => (
              <button
                key={suggestion.term}
                type="button"
                onClick={() => handleSynonymInsert(suggestion.term)}
                title={`Also search for "${suggestion.term}" (related to "${suggestion.matched}")`}
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
                + {suggestion.term}
              </button>
            ))}
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

          <div className="flex flex-shrink-0 items-center gap-1">
            <WorkspaceMenu />
          </div>
        </div>
      </div>
    </div>
  );
};

export default LogSearch;
