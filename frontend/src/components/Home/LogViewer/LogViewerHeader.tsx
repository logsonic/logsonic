import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import {
  Columns,
  Lock,
  Maximize2,
  Search,
  Unlock,
  X,
  XCircle
} from 'lucide-react';
import { useCallback, useState } from 'react';


/**
 * LogViewer Header component with controls
 */
export const LogViewerHeader = (
  {autofitColumns}: {autofitColumns: () => void}

) => {
  const store = useSearchQueryParamsStore();

  // Toggle lock state
  const toggleLock = useCallback(() => {
    store.setColumnLocked(!store.isColumnLocked); 
  }, [store.isColumnLocked]);

  const { systemInfo } = useSystemInfoStore();

  const [isColumnPopoverOpen, setIsColumnPopoverOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState('');

 
  // Filter out _raw and _src fields
  const availableColumns = store.availableColumns.filter(column => column !== '_raw' && column !== '_src');

  // Filter columns based on search query
  const filteredColumns = headerSearchQuery 
    ? availableColumns.filter(column => column.toLowerCase().includes(headerSearchQuery.toLowerCase()))
    : availableColumns;

  // Handle column selection change
  const handleColumnSelectionChange = useCallback((columns: string[]) => {
    store.setSelectedColumns(columns);
    autofitColumns();
  }, [store]);

  // Toggle individual column visibility
  const handleToggleColumn = useCallback((column: string, isVisible: boolean) => {
    // Prevent toggling the _raw and _src fields
    if (column === '_raw' || column === '_src') return;
    
    if (isVisible) {
      // Add column if it's not already selected
      if (!store.selectedColumns.includes(column)) {
        store.setSelectedColumns([...store.selectedColumns, column]);
      }
    } else {
      // Remove column if it's not mandatory
      const mandatoryColumns = store.mandatoryColumns;
      if (!mandatoryColumns.includes(column)) {
        store.setSelectedColumns(store.selectedColumns.filter(col => col !== column));
      }
    }
  }, [store]);

  return (
    <div
      className="flex items-center justify-between px-3 py-1.5"
      style={{
        background: 'var(--ls-panel)',
        borderBottom: '1px solid var(--ls-border)',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="ls-toolbar-group flex items-center overflow-hidden rounded-md"
          style={{
            background: 'var(--ls-bg-1)',
            border: '1px solid var(--ls-border)',
          }}
        >
          <div
            className="px-2.5 py-1"
            style={{
              background: 'var(--ls-bg-2)',
              borderRight: '1px solid var(--ls-border)',
            }}
          >
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: 'var(--ls-text-3)' }}
            >
              Columns
            </span>
          </div>

          <Popover open={isColumnPopoverOpen} onOpenChange={setIsColumnPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                disabled={store.isColumnLocked}
                className="ls-toolbar-btn h-7 rounded-none px-2.5 flex items-center gap-1"
              >
                <Columns className="h-3.5 w-3.5" />
                <span className="text-xs">Select</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-96 p-4" side="right" align="center">
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h4 className="font-medium text-base">Select Columns</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => setIsColumnPopoverOpen(false)}
                  >
                    <X className="h-4 w-4" style={{ color: 'var(--ls-text-3)' }} />
                    <span className="sr-only">Close</span>
                  </Button>
                </div>

                {/* Search input */}
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4" style={{ color: 'var(--ls-text-3)' }} />
                  <Input
                    placeholder="Search columns..."
                    value={headerSearchQuery}
                    onChange={(e) => setHeaderSearchQuery(e.target.value)}
                    className="pl-8"
                  />
                  {headerSearchQuery && (
                    <button
                      className="absolute right-2 top-2.5"
                      style={{ color: 'var(--ls-text-3)' }}
                      onClick={() => setHeaderSearchQuery('')}
                      aria-label="Clear search"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {/* Multi-column layout for column selection */}
                <div className="max-h-[300px] overflow-y-auto pr-2">
                  <div className="grid grid-cols-2 gap-1">
                    {filteredColumns.map((column) => (
                      <div
                        key={column}
                        className="flex items-center space-x-2 p-1 rounded ls-col-row"
                      >
                        <Checkbox
                          id={`col-${column}`}
                          checked={store.selectedColumns.includes(column)}
                          disabled={column === 'timestamp'}
                          onCheckedChange={(checked) => handleToggleColumn(column, !!checked)}
                          className="h-4 w-4"
                        />
                        <Label htmlFor={`col-${column}`} className="text-sm cursor-pointer flex-1 truncate">
                          {column}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Quick actions */}
                <div
                  className="flex justify-between items-center pt-2"
                  style={{ borderTop: '1px solid var(--ls-border)' }}
                >
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Clear all except mandatory columns
                        handleColumnSelectionChange(store.mandatoryColumns);
                      }}
                    >
                      Clear All
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Select all columns
                        handleColumnSelectionChange([...availableColumns]);
                      }}
                    >
                      Select All
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    className="text-white"
                    style={{ background: 'var(--ls-accent)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ls-accent-hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--ls-accent)')}
                    onClick={() => setIsColumnPopoverOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: 'var(--ls-border)' }} />

          <Button
            variant="ghost"
            className="ls-toolbar-btn h-7 rounded-none px-2.5 flex items-center gap-1"
            onClick={autofitColumns}
            disabled={store.isColumnLocked}
            title="Auto-adjust column widths"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="text-xs">Fit</span>
          </Button>

          <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: 'var(--ls-border)' }} />

          <Button
            variant="ghost"
            className="ls-toolbar-btn h-7 rounded-none px-2.5 flex items-center gap-1"
            onClick={toggleLock}
            title={store.isColumnLocked ? "Unlock layout" : "Lock layout"}
          >
            {store.isColumnLocked ? (
              <>
                <Unlock className="h-3.5 w-3.5" />
                <span className="text-xs">Unlock</span>
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5" />
                <span className="text-xs">Lock</span>
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Stats — "matches" is the count after the search query + time range
          filter; "indexed" is the total in storage. Showing both with explicit
          labels avoids the old ambiguous "500 / 2,500 logs". */}
      <div className="flex items-center gap-3">
        <div className="text-xs" style={{ color: 'var(--ls-text-3)' }}>
          {store.resultCount > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="font-semibold" style={{ color: 'var(--ls-text)', fontFamily: 'var(--ls-font-mono)' }}>
                {store.resultCount.toLocaleString()}
              </span>
              <span style={{ color: 'var(--ls-text-4)' }}>matches</span>
              {systemInfo?.storage_info?.total_log_entries != null && systemInfo.storage_info.total_log_entries !== store.resultCount && (
                <span style={{ color: 'var(--ls-text-4)' }}>
                  · {systemInfo.storage_info.total_log_entries.toLocaleString()} indexed
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: 'var(--ls-text-4)', fontStyle: 'italic' }}>No matches</span>
          )}
        </div>
      </div>
    </div>
  );
}; 