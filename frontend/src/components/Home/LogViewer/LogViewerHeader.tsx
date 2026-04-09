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
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 bg-slate-50/50">
      <div className="flex items-center gap-2">
        <div className="flex items-center border border-slate-200 rounded-md overflow-hidden bg-white shadow-sm">
          <div className="px-2.5 py-1 bg-slate-50 border-r border-slate-200">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Columns</span>
          </div>
          
          <Popover open={isColumnPopoverOpen} onOpenChange={setIsColumnPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" disabled={store.isColumnLocked} className="h-7 rounded-none border-r border-slate-200 px-2.5 flex items-center gap-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100">
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
                    <X className="h-4 w-4 text-gray-500 hover:text-gray-900" />
                    <span className="sr-only">Close</span>
                  </Button>
                </div>
                
                {/* Search input */}
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Search columns..."
                    value={headerSearchQuery}
                    onChange={(e) => setHeaderSearchQuery(e.target.value)}
                    className="pl-8"
                  />
                  {headerSearchQuery && (
                    <button 
                      className="absolute right-2 top-2.5 text-gray-400 hover:text-gray-600"
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
                      <div key={column} className="flex items-center space-x-2 p-1 hover:bg-gray-50 rounded">
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
                <div className="flex justify-between pt-2 border-t">
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
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant="ghost"
            className="h-7 rounded-none border-r border-slate-200 px-2.5 flex items-center gap-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            onClick={autofitColumns}
            disabled={store.isColumnLocked}
            title="Auto-adjust column widths"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="text-xs">Fit</span>
          </Button>

          <Button
            variant="ghost"
            className="h-7 rounded-none px-2.5 flex items-center gap-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
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

      {/* Stats */}
      <div className="flex items-center gap-3">
        <div className="text-xs text-slate-500">
          {store.resultCount > 0 ? (
            <span className="flex items-center gap-1">
              <span className="font-semibold text-slate-700">{store.resultCount.toLocaleString()}</span>
              {systemInfo?.storage_info?.total_log_entries != null && systemInfo.storage_info.total_log_entries !== store.resultCount ? (
                <span className="text-slate-400">
                  / {systemInfo.storage_info.total_log_entries.toLocaleString()} logs
                </span>
              ) : (
                <span className="text-slate-400">logs</span>
              )}
            </span>
          ) : (
            <span className="text-slate-400 italic">No results</span>
          )}
        </div>
      </div>
    </div>
  );
}; 