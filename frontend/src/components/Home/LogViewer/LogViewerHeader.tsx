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
import { useCallback, useEffect, useState } from 'react';


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
  const [localSearchQuery, setLocalSearchQuery] = useState('');

  // Update search query when it changes asynchronously
  useEffect(() => {
    setLocalSearchQuery(store.searchQuery);
  }, [store.searchQuery]);

  
  // Filter out _raw and _src fields
  const availableColumns = store.availableColumns.filter(column => column !== '_raw' && column !== '_src');

  // Filter columns based on search query
  const filteredColumns = localSearchQuery 
    ? availableColumns.filter(column => column.toLowerCase().includes(localSearchQuery.toLowerCase()))
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
    <div className="flex items-center justify-between p-2 border-b">
      <div className="flex items-center gap-4">
        <div className="flex items-center border rounded-md overflow-hidden">
          <div className="px-3 py-1.5 bg-gray-50 border-r">
            <span className="text-sm font-medium">Columns</span>
          </div>
          
          <Popover open={isColumnPopoverOpen} onOpenChange={setIsColumnPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" disabled={store.isColumnLocked} className="h-9 rounded-none border-r px-3 flex items-center gap-1">
                <Columns className="h-4 w-4" />
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
                    value={localSearchQuery}
                    onChange={(e) => setLocalSearchQuery(e.target.value)}
                    className="pl-8"
                  />
                  {localSearchQuery && (
                    <button 
                      className="absolute right-2 top-2.5 text-gray-400 hover:text-gray-600"
                      onClick={() => setLocalSearchQuery('')}
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
            className="h-9 rounded-none border-r px-3 flex items-center gap-1"
            onClick={autofitColumns}
            disabled={store.isColumnLocked}
            title="Auto-adjust column widths"
          >
            <Maximize2 className="h-4 w-4" />
            <span className="text-xs">Fit</span>
          </Button>

          <Button 
            variant="ghost" 
            className="h-9 rounded-none px-3 flex items-center gap-1"
            onClick={toggleLock}
            title={store.isColumnLocked ? "Unlock layout" : "Lock layout"}
          >
            {store.isColumnLocked ? (
             <>
             <Unlock className="h-4 w-4" />
             <span className="text-xs">Unlock</span>
           </>
            ) : (
              <>
              <Lock className="h-4 w-4" />
              <span className="text-xs">Lock</span>
            </>
              
            )}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4">
        <div className="text-sm text-gray-500">
          {store.resultCount > 0 ? (
            <>
              Showing {store.resultCount}  
              {systemInfo?.storage_info?.total_log_entries != store.resultCount ? (
                <>
                   &nbsp;out of &nbsp;{systemInfo?.storage_info?.total_log_entries.toLocaleString()} 
                </>
              ) : null} logs
            </>
          ) : "No logs to display"}
        </div>
      </div>
    </div>
  );
}; 