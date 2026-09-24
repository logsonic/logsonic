import { Bookmark, Star, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import type { WorkspaceTime } from '@/lib/api-types';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchStateToWorkspaceTime } from '@/lib/workspace-utils';
import { useQueryHistoryStore } from '@/stores/useQueryHistoryStore';
import { useSavedQueryDraftStore } from '@/stores/useSavedQueryDraftStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';

// Spec now-03's "1..60 chars" for a saved query's name -- matches the
// backend's maxSavedQueryNameLen (pkg/workspaces/store.go).
const MAX_NAME_LENGTH = 60;
const DEFAULT_NAME_TRUNCATE = 40;
const MAX_HISTORY_SHOWN = 10;

interface SavedQueriesMenuProps {
  currentQuery: string;
  onApply: (query: string, time?: WorkspaceTime, sources?: string[]) => void;
}

// The star (save-this-query popover) and the bookmark/history dropdown
// (spec now-03 step 5), grouped together since both sit at the search
// input's right edge next to the clear button.
export const SavedQueriesMenu = ({ currentQuery, onApply }: SavedQueriesMenuProps) => {
  const savedQueries = useSavedQueryDraftStore((state) => state.savedQueries);
  const addSavedQuery = useSavedQueryDraftStore((state) => state.addSavedQuery);
  const removeSavedQuery = useSavedQueryDraftStore((state) => state.removeSavedQuery);
  const historyEntries = useQueryHistoryStore((state) => state.entries);
  const clearHistory = useQueryHistoryStore((state) => state.clear);

  const [starOpen, setStarOpen] = useState(false);
  const [name, setName] = useState('');
  // Radix DropdownMenuItem drives onSelect from its own pointer handling,
  // not the delete button's React onClick -- stopPropagation on the click
  // doesn't stop onSelect from also firing (would apply-then-delete in one
  // click). Set on pointerdown, before Radix's own selection logic runs.
  const deletePending = useRef(false);

  const defaultName = useMemo(
    () => currentQuery.trim().slice(0, DEFAULT_NAME_TRUNCATE) || 'Untitled query',
    [currentQuery]
  );

  const handleStarOpenChange = (open: boolean) => {
    setStarOpen(open);
    if (open) setName(defaultName);
  };

  const handleSaveStarred = () => {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) return;
    const search = useSearchQueryParamsStore.getState();
    addSavedQuery({
      name: trimmed,
      query: currentQuery,
      time: searchStateToWorkspaceTime(search),
      sources: search.sources.length > 0 ? [...search.sources] : undefined,
    });
    setStarOpen(false);
  };

  const recentHistory = historyEntries.slice(0, MAX_HISTORY_SHOWN);

  return (
    <>
      <Popover open={starOpen} onOpenChange={handleStarOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-gray-200 focus:outline-none"
            title="Save this query"
            aria-label="Save this query"
          >
            <Star size={14} style={{ color: 'var(--ls-text-3)' }} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 space-y-2 p-3"
          style={{ background: 'var(--ls-panel)', borderColor: 'var(--ls-border-strong)' }}
        >
          <div className="ls-meta-label">Save query</div>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Name"
            className="h-8 text-xs"
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSaveStarred();
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={!name.trim()}
            onClick={handleSaveStarred}
            className="h-8 w-full gap-1.5 text-xs text-white"
            style={{ background: 'var(--ls-accent)' }}
          >
            <Star className="h-3.5 w-3.5" />
            Save
          </Button>
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-gray-200 focus:outline-none"
            title="Saved queries & history"
            aria-label="Saved queries & history"
          >
            <Bookmark size={14} style={{ color: 'var(--ls-text-3)' }} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Saved queries</DropdownMenuLabel>
          {savedQueries.length === 0 && (
            <div className="px-2 py-1.5 text-xs" style={{ color: 'var(--ls-text-3)' }}>
              None yet — star a query to save it.
            </div>
          )}
          {savedQueries.map((sq) => (
            <DropdownMenuItem
              key={sq.id}
              className="group flex items-center justify-between gap-2"
              onSelect={(event) => {
                if (deletePending.current) {
                  deletePending.current = false;
                  event.preventDefault();
                  return;
                }
                onApply(sq.query ?? '', sq.time, sq.sources);
              }}
            >
              <span className="truncate">{sq.name}</span>
              <button
                type="button"
                className="opacity-0 group-hover:opacity-100 hover:text-red-600"
                onPointerDown={() => {
                  deletePending.current = true;
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  removeSavedQuery(sq.id);
                }}
                aria-label={`Delete ${sq.name}`}
                title={`Delete ${sq.name}`}
              >
                <X size={12} />
              </button>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Recent</DropdownMenuLabel>
          {recentHistory.length === 0 && (
            <div className="px-2 py-1.5 text-xs" style={{ color: 'var(--ls-text-3)' }}>
              No history yet.
            </div>
          )}
          {recentHistory.map((entry, index) => (
            <DropdownMenuItem
              key={`${entry.query}-${entry.at}-${index}`}
              onSelect={() => onApply(entry.query, entry.time, entry.sources)}
            >
              <span
                className="truncate"
                style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 11.5 }}
              >
                {entry.query}
              </span>
            </DropdownMenuItem>
          ))}
          {historyEntries.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => clearHistory()} className="gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Clear history
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

export default SavedQueriesMenu;
