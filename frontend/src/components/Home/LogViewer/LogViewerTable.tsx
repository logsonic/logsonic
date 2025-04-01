import {
  ColumnResizeMode,
  Header,
  RowSelectionState,
  SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileUp, GripVertical, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ExpandedRow } from '@/components/Home/ExpandedRow';
import { LogViewerSkeleton } from '@/components/Home/LogViewer/LogViewerSkeleton';
import { Resizer } from '@/components/Home/Resizer';
import { useSearchParser } from '@/hooks/useSearchParser.tsx';
import { ColorRule, useColorRuleStore } from '@/stores/useColorRuleStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import React from 'react';
import './LogViewerTableTanStackStyles.css';

// Import DnD Kit
import { Button } from '@/components/ui/button';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';

// Define the type for log data
type LogData = Record<string, any>;

const fixedColumns = ['select', 'expander'];

// Sortable header component
interface SortableHeaderProps {
  header: Header<LogData, unknown>;
  isLocked: boolean;
  handleSort: (columnId: string) => void;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ header, isLocked, handleSort }) => {

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: header.id,
    disabled: isLocked || fixedColumns.includes(header.id),
  });

  const isUtilityColumn = fixedColumns.includes(header.id);

  const style: React.CSSProperties = {
    transform: transform ? `translateX(${transform.x}px)` : undefined,
    transition,
    opacity: isDragging ? 0.8 : 1,
    position: 'relative',
    width: header.getSize(),
    zIndex: isDragging ? 1 : 0,
  };

  return (
    <th
      ref={setNodeRef}
      data-column-id={header.id}
      className={`relative border-b border-slate-200 bg-white px-2 py-2 text-left font-medium text-slate-700 ${
        header.column.getCanSort() ? 'cursor-pointer select-none' : ''
      } ${isUtilityColumn ? `w-[40px] min-w-[40px] max-w-[40px] text-center` : ''}`}
      style={style}
      onClick={
        header.column.getCanSort()
          ? (e) => {
              if (isDragging) return;
              handleSort(header.id);
            }
          : undefined
      }
    >
      {isUtilityColumn ? (
        // For utility columns (select/expander), render directly without the flex container
        flexRender(header.column.columnDef.header, header.getContext())
      ) : (
        // For regular data columns, use the flex container with resizer
        <div className="flex items-center group/header pr-6">
          {!isLocked && (
            <span
              {...attributes}
              {...listeners}
              className="drag-handle mr-2 cursor-grab"
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className="h-4 w-4 text-slate-400" />
            </span>
          )}

          <div className="flex-1 truncate">
            {header.isPlaceholder
              ? null
              : flexRender(header.column.columnDef.header, header.getContext())}
          </div>

          {header.column.getCanResize() && <Resizer columnId={header.id} />}
        </div>
      )}
    </th>
  );
};

/**
 * LogViewer Table component using TanStack Table
 */
export const LogViewerTable = React.forwardRef((props, ref) => {

  const store = useSearchQueryParamsStore();
  const { logData, isLoading } = useLogResultStore();
  const { colorRules } = useColorRuleStore();
  const logs = logData?.logs || [];
  const { parseSearchQuery, createHighlighter } = useSearchParser();
  const navigate = useNavigate();

  const tableRef = useRef<HTMLTableElement>(null);
  const [tableHeight, setTableHeight] = useState('calc(100vh - 240px)');

  // Function to calculate optimal table height
  const calculateTableHeight = useCallback(() => {
    // Base UI elements heights (approximate)
    const headerHeight = 60;  // Top navbar/header
    const searchBarHeight = 60; // Search input area
    const paginationHeight = 60; // Pagination controls
    const padding = 60; // Additional padding/margins
    
    // Calculate available height
    const viewportHeight = window.innerHeight;
    const availableHeight = viewportHeight - (headerHeight + searchBarHeight + paginationHeight + padding);
    
    // Update the table height
    setTableHeight(`${availableHeight}px`);
  }, []);

  // Recalculate height on window resize
  useEffect(() => {
    calculateTableHeight();
    
    const handleResize = () => {
      calculateTableHeight();
    };
    
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [calculateTableHeight]);

  // Recalculate when page size changes
  useEffect(() => {
    calculateTableHeight();
  }, [store.pageSize, calculateTableHeight]);

  // Extract search tokens from the current query
  const searchTokens = useMemo(() => {
    return parseSearchQuery(store.searchQuery || '');
  }, [store.searchQuery, parseSearchQuery]);

  // Create highlighter function
  const highlightText = useMemo(() => {
    return createHighlighter(searchTokens);
  }, [searchTokens, createHighlighter]);

  const { systemInfo } = useSystemInfoStore();
  const noLogsInSystem = useMemo(() => {
    return systemInfo?.storage_info?.total_log_entries === 0;
  }, [systemInfo]);

  const autofitColumns = useCallback(() => {
    
    if (store.selectedColumns.length === 0) return;
    if ( !logData || !logData.logs || logData.logs.length === 0) return;
    
    // Calculate optimal width for each column based on content
    const columnWidths: Record<string, number> = {};
    
    // Set fixed widths for utility columns - these should never be adjusted
    columnWidths['select'] = 40;
    columnWidths['expander'] = 40;
    
    // Get the container width
    const containerWidth = tableRef.current?.clientWidth || 0;
    
    // First pass: calculate content-based widths
    const contentBasedWidths: Record<string, number> = {};
    let totalContentWidth = 0;
    
    // Process each selected column (excluding utility columns)
    store.selectedColumns.forEach(column => {
      // Skip utility columns as they have fixed widths
      if (column === 'select' || column === 'expander' || column === '_raw' || column === '_src') return;
      
      // Start with column name length (plus some padding)
      let maxContentWidth = column.length * 10;
      
      // Sample up to 100 logs to avoid performance issues with large datasets
      const sampleSize = Math.min(logData.logs.length, store.pageSize);
      const sampleLogs = logData.logs.slice(0, sampleSize);
      
      // Find the maximum content width
      sampleLogs.forEach(log => {
        const value = log[column];
        if (value !== undefined && value !== null) {
          const stringValue = typeof value === 'object' 
            ? JSON.stringify(value).length 
            : String(value).length;
          
          // Use character count as a proxy for width (with some multiplier)
          const estimatedWidth = Math.min(stringValue * 8, 500); // Cap at 500px
          
          maxContentWidth = Math.max(maxContentWidth, estimatedWidth);
        }
      });
      
      // Set a reasonable width with min/max constraints
      contentBasedWidths[column] = Math.max(120, Math.min(maxContentWidth, 600));
      totalContentWidth += contentBasedWidths[column];
    });
    
    // Add utility column widths to total
    const utilityColumnsWidth = columnWidths['select'] + columnWidths['expander'];
    totalContentWidth += utilityColumnsWidth;
    
    // Second pass: distribute space proportionally based on container width
    const availableWidth = containerWidth;
    
    // If calculated widths are too small for the container, expand them proportionally
    if (totalContentWidth < availableWidth) {
      // Determine how much extra space we have
      const extraSpace = availableWidth - totalContentWidth;
      
      // Calculate expansion factor for each data column
      const dataColumnsCount = Object.keys(contentBasedWidths).length;
      if (dataColumnsCount > 0) {
        const expansionPerColumn = extraSpace / dataColumnsCount;
        
        // Expand each non-utility column
        Object.keys(contentBasedWidths).forEach(column => {
          columnWidths[column] = contentBasedWidths[column] + expansionPerColumn;
        });
      }
    } 
    // If calculated widths exceed container, reduce them proportionally
    else if (totalContentWidth > availableWidth) {
      // Calculate shrink factor
      const shrinkFactor = availableWidth / totalContentWidth;
      
      // Apply shrink factor to each data column
      Object.keys(contentBasedWidths).forEach(column => {
        // Apply shrink factor but maintain minimum width
        columnWidths[column] = Math.max(120, contentBasedWidths[column] * shrinkFactor);
      });
    } 
    // If perfect fit, use the content-based widths directly
    else {
      Object.keys(contentBasedWidths).forEach(column => {
        columnWidths[column] = contentBasedWidths[column];
      });
    }
    
    // Update column widths in the store
    store.setColumnWidths(columnWidths);
    
  }, [logData, store.selectedColumns, store.pageSize]);

  // Expose the autofitColumns function through the ref
  React.useImperativeHandle(ref, () => ({
    autofitColumns
  }));

  // Handle sort change
  const handleSort = useCallback((column: string) => {
    if (store.sortBy === column) {
      // Toggle sort order if clicking the same column
      const newSortOrder = store.sortOrder === 'asc' ? 'desc' : 'asc';
      store.setSortOrder(newSortOrder);
    } else {
      // Set new sort column and default to descending order
      store.setSortBy(column);
      store.setSortOrder('desc');
    }
    store.resetPagination();
  }, [store]);

  useEffect(() => {
    autofitColumns();
  }, [store.selectedColumns]);

  // State for column resizing
  const [columnResizeMode, setColumnResizeMode] = useState<ColumnResizeMode>('onChange');
  
  // State for expanded rows
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  
  // State for selected rows
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  
  // State for sorting
  const [sorting, setSorting] = useState<SortingState>([
    { id: store.sortBy || 'timestamp', desc: store.sortOrder === 'desc' }
  ]);

  // State for column order - initialize with fixed columns + selected columns
  const [columnOrder, setColumnOrder] = useState<string[]>([...fixedColumns, ...store.selectedColumns.filter(col => col !== '_raw' && col !== '_src')]);

  // Update column order when selectedColumns change
  useEffect(() => {
    // Filter out _raw and _src from the selected columns
    const filteredColumns = store.selectedColumns.filter(column => column !== '_raw' && column !== '_src');
    setColumnOrder([...fixedColumns, ...filteredColumns]);
  }, [store.selectedColumns]);

  // Update local sorting state when context sorting changes
  useEffect(() => {
    setSorting([{ id: store.sortBy || 'timestamp', desc: store.sortOrder === 'desc' }]);
  }, [store.sortBy, store.sortOrder]);

  // Format timestamp for display
  const formatTimestamp = useCallback((timestamp: string) => {
    if (!timestamp) return '';
    //Timestamp is in UTC format
    try {
      const date = new Date(timestamp);

      // Use a more compatible approach for formatting with timezone
      const formattedDate = new Intl.DateTimeFormat("default", {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: store.timeZone,
        timeZoneName: "short"

      }).format(date);

      return formattedDate;
    } catch (e) {
      console.error("Error formatting timestamp:", e);
      return timestamp;
    }
  }, [store.timeZone]);

  // Column helper for easier column definition
  const columnHelper = createColumnHelper<LogData>();

  // Create columns configuration for TanStack Table
  const columns = useMemo(() => {
    // Selection column
    const selectionColumn = columnHelper.display({
      id: 'select',
      header: ({ table }) => (
        <div className="flex items-center justify-center w-full h-full">
          <input
            type="checkbox"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="h-4 w-4 rounded border-gray-300 cursor-pointer"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            className="h-4 w-4 rounded border-gray-300 cursor-pointer"
          />
        </div>
      ),
      size: 40, // Fixed size for checkbox column
      minSize: 40, // Minimum size
      maxSize: 40, // Maximum size
      enableResizing: false,
    });

    // Expander column
    const expanderColumn = columnHelper.display({
      id: 'expander',
      header: () => null,
      cell: ({ row }) => (
        <div 
          className="expander-button cursor-pointer flex items-center justify-center"
          onClick={() => {
            setExpanded(prev => ({
              ...prev,
              [row.id]: !prev[row.id]
            }));
          }}
        >
          {expanded[row.id] ? (
            <ChevronDown className="h-4 w-4 text-slate-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-500" />
          )}
        </div>
      ),
      size: 20, // Fixed size for expander column
      minSize: 20, // Minimum size
      maxSize: 20, // Maximum size
      enableResizing: false,
    });

    // Data columns
    const dataColumns = store.selectedColumns
      .filter(column => column !== '_raw' && column !== '_src') // Exclude _raw and _src fields from columns
      .map(column => 
      columnHelper.accessor(
        (row) => {
          const value = row[column];
          return column === 'timestamp' ? formatTimestamp(value) : String(value || '');
        },
        {
          id: column,
          header: () => (
            <div className="flex items-center">
              <span>{column}</span>
              {store.sortBy === column && (
                <div className="flex items-center ml-1">
                  {store.sortOrder === 'asc' ? (
                    <>
                      <ArrowUp className="h-4 w-4" />
                      <span className="text-xs ml-1 text-gray-500">Asc</span>
                    </>
                  ) : (
                    <>
                      <ArrowDown className="h-4 w-4" />
                      <span className="text-xs ml-1 text-gray-500">Desc</span>
                    </>
                  )}
                </div>
              )}
            </div>
          ),
          cell: info => {
            const text = info.getValue();
            // Use the highlight function to highlight search matches
            return <div className="truncate">{highlightText(text, column)}</div>;
          },
          size: store.columnWidths[column] || 150,
          enableResizing: !store.isColumnLocked,
          enableSorting: true, // Always enable sorting for debugging
        }
      )
    );

  

    return [selectionColumn, expanderColumn, ...dataColumns];
  }, [store.selectedColumns, formatTimestamp, store.sortBy, store.sortOrder, expanded, store.isColumnLocked, columnHelper, store.columnWidths]);

  // Set up DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement before drag starts
      },
    }),
    useSensor(KeyboardSensor)
  );

  // Handle drag end for column reordering
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over) return;
    
    if (active.id !== over.id) {
      // Update local column order state first
      let newColumnOrder: string[] = [];
      
      setColumnOrder((items) => {
        const oldIndex = items.indexOf(active.id as string);
        const newIndex = items.indexOf(over.id as string);
        
        newColumnOrder = arrayMove(items, oldIndex, newIndex);
        return newColumnOrder;
      });
      
      // After updating the local state, update the store's selectedColumns
      // to preserve the new order while keeping _raw and _src fields if present
      setTimeout(() => {
        const updatedColumns = newColumnOrder.filter(col => !fixedColumns.includes(col));
        const hiddenColumns = store.selectedColumns.filter(col => col === '_raw' || col === '_src');
        
        store.setSelectedColumns([...updatedColumns, ...hiddenColumns]);
      }, 0);
    }
  }, [store]);

  // Create table instance
  const table = useReactTable({
    data: logs,
    columns,
    state: {
      sorting,
      rowSelection,
      columnOrder,
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode,
    enableColumnResizing: !store.isColumnLocked,
    manualSorting: true,
    debugTable: false, // Enable table debugging
    debugHeaders: false, // Enable headers debugging
    debugColumns: false, // Enable columns debugging
    autoResetPageIndex: false, // Prevent page reset on sorting
    onColumnOrderChange: setColumnOrder,
    // Add handler for column resize
    onColumnSizingChange: (updater) => {
      // Get the current sizing state
      const currentSizing = table.getState().columnSizing;
      
      // Apply the update to get the new sizing state
      let newSizing;
      if (typeof updater === 'function') {
        newSizing = updater(currentSizing);
      } else {
        newSizing = updater;
      }
      
      // Save the new column widths to the store
      const newWidths = { ...store.columnWidths };
      
      // Update widths for each resized column
      Object.entries(newSizing).forEach(([columnId, width]) => {
        // Ensure width is a number
        newWidths[columnId] = typeof width === 'number' ? width : parseInt(String(width), 10);
      });
      
      store.setColumnWidths(newWidths);
    },
  });

  // Force table to update when column widths change
  useEffect(() => {
    // This will force the table to recalculate with the new column sizes
    table.setOptions(prev => ({
      ...prev,
      columns: [...columns], // Create a new array to force update
    }));
    
  }, [store.selectedColumns, store.columnWidths, columns, table]);



  

  // Calculate selected rows count
  const selectedRowsCount = Object.keys(rowSelection).length;

  // Add an effect to update column sizes when columnWidths change
  useEffect(() => {
    if (Object.keys(store.columnWidths).length > 0) {
      
      // Update column sizes in the table
      table.getAllColumns().forEach(column => {
        const columnId = column.id;
        
        // Ensure utility columns maintain their fixed size
        if (fixedColumns.includes(columnId)) {
          column.columnDef.size = 40;
          return;
        }
        
        const width = store.columnWidths[columnId];
        if (width) {
          // Use the correct method to resize columns
          column.columnDef.size = width;
        }
      });
    }
  }, [store.columnWidths, table]);

  // A simple cache for memoizing style results
  const styleCache = useRef(new Map());
  
  // Clear style cache when color rules change
  useEffect(() => {
    styleCache.current.clear();
  }, [colorRules]);

  // Function to check if a field value matches a rule
  const checkRuleMatch = (fieldValue: any, rule: ColorRule): boolean => {
    // For the "exists" operator, we just check if field has any value
    if (rule.operator === 'exists') {
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
    }
    
    // For all other operators, we need a value to compare against
    if (fieldValue === undefined || fieldValue === null) return false;
    
    // Convert to string for comparison
    const rowValue = String(fieldValue);
    const ruleValue = rule.value;
    
    // Case insensitive comparison for most operators except regex
    const rowValueLower = rowValue.toLowerCase();
    const ruleValueLower = ruleValue.toLowerCase();
    
    // Check based on operator
    switch (rule.operator) {
      case 'eq':
        return rowValueLower === ruleValueLower;
      case 'neq':
        return rowValueLower !== ruleValueLower;
      case 'contains':
        return rowValueLower.includes(ruleValueLower);
      case 'regex':
        try {
          const regex = new RegExp(ruleValue);
          return regex.test(rowValue);
        } catch (e) {
          console.error('Invalid regex in color rule:', e);
          return false;
        }
      default:
        return false;
    }
  };

  // Function to get row styles based on color rules
  const getRowStyles = useCallback((row: LogData, isSelected: boolean) => {
    // Create a cache key using the row ID (or a hash of the row), rule count, and selection state
    // This assumes each row has a unique ID or key property
    const rowId = row.id || JSON.stringify(row);
    const cacheKey = `${rowId}-${colorRules.length}-${isSelected}`;
    
    // Check if we already computed this result
    if (styleCache.current.has(cacheKey)) {
      return styleCache.current.get(cacheKey);
    }
    
    // Create base result object with selection class if needed
    let result = { 
      className: isSelected ? 'selected-row' : '',
      colorClass: '',
      title: '',
    };
    
    // Skip color rule processing if no rules or row is empty
    if (!colorRules || colorRules.length === 0 || !row) {
      styleCache.current.set(cacheKey, result);
      return result;
    }

    // Filter out disabled rules
    const activeRules = colorRules.filter(rule => rule.enabled);

    // Check if any rule matches this row
    // Rules are applied in order of definition (first match wins)
    for (const rule of activeRules) {
      if (checkRuleMatch(row[rule.field], rule)) {
        // Create a tooltip showing the rule that matched
        let operatorSymbol;
        switch (rule.operator) {
          case 'eq': operatorSymbol = '=='; break;
          case 'neq': operatorSymbol = '!='; break;
          case 'contains': operatorSymbol = 'contains'; break;
          case 'exists': operatorSymbol = 'exists'; break;
          case 'regex': operatorSymbol = 'matches regex'; break;
          default: operatorSymbol = rule.operator;
        }
        
        const tooltip = rule.operator === 'exists' 
          ? `Rule: ${rule.field} exists` 
          : `Rule: ${rule.field} ${operatorSymbol} "${rule.value}"`;
        
        // Update the result with the color class and tooltip
        result.colorClass = rule.color;
        result.title = tooltip;
        
        // Cache and return the result
        styleCache.current.set(cacheKey, result);
        return result;
      }
    }
    
    // No match - return base result
    styleCache.current.set(cacheKey, result);
    return result;
  }, [colorRules]);

  if (isLoading) {
    return (
      <div className="p-4">
        <LogViewerSkeleton columns={store.selectedColumns.length} rows={10} />
      </div>
    );
  }

    if (logs.length === 0) {

      if (noLogsInSystem){
        return (<div className="flex flex-col items-center justify-center text-slate-500 h-full" style={{marginTop: '-10vh'}}>
        <div className="max-w-lg text-center">
          <div className="mb-6 relative">
            <FileUp className="h-16 w-16 text-blue-500 mx-auto animate-bounce" />
            <div className="absolute w-8 h-8 rounded-full bg-blue-100 -z-10 top-4 left-1/2 transform -translate-x-1/2 animate-ping" />
          </div>
          <h3 className="text-2xl font-medium text-slate-800 mb-3">No logs found!</h3>
          <p className="text-lg mb-6 text-slate-600">
            Looks like your log storage is as empty as a developer's coffee cup on Monday morning!
          </p>
          <Button 
            onClick={() =>  navigate('/import')} 
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
          >
            <Upload className="h-4 w-4" />
            <span>Import Some Logs</span>
          </Button>
        </div>
      </div>)
        }
    
      return (
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">No logs to display</p>
        </div>
      );
    }

  return (
    <div className={store.isColumnLocked ? 'locked-table' : ''}>
      <div ref={tableRef}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToHorizontalAxis]}
        >
          <table 
            className="w-full border-collapse"
            style={{ width: table.getCenterTotalSize() }}
          >
            <thead>
              {table.getHeaderGroups().map(headerGroup => (
                <SortableContext
                  key={headerGroup.id}
                  items={headerGroup.headers.map(header => header.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  <tr>
                    {headerGroup.headers.map(header => (
                      <SortableHeader 
                        key={header.id}
                        header={header}
                        isLocked={store.isColumnLocked}
                        handleSort={handleSort}
                      />
                    ))}
                  </tr>
                </SortableContext>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map(row => {
                const rowStyleInfo = getRowStyles(row.original, row.getIsSelected());
                
                return (
                  <React.Fragment key={row.id}>
                    <tr 
                      className={`border-b border-slate-200 log-row ${rowStyleInfo.className} ${rowStyleInfo.colorClass}`}
                      title={rowStyleInfo.title}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td 
                          key={cell.id}
                          className={`${
                            cell.column.id === 'select' ? 'w-[40px] min-w-[40px] max-w-[40px] text-center px-2 py-2' : 
                            cell.column.id === 'expander' ? 'w-[40px] min-w-[20px] max-w-[20px] text-center' : 'pl-6 py-2'
                          }`}
                          data-column-id={cell.column.id}
                          style={{
                            width: cell.column.getSize(),
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {expanded[row.id] && (
                      <tr 
                        key={`expanded-${row.id}`} 
                        className={`log-row ${rowStyleInfo.className} ${rowStyleInfo.colorClass}`}
                        title={rowStyleInfo.title}
                      >
                        <td colSpan={row.getVisibleCells().length} className="p-0">
                          <ExpandedRow data={row.original} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </DndContext>
      </div>
      
      {selectedRowsCount > 0 && (
        <div className="fixed bottom-4 right-4 bg-white shadow-lg rounded-md p-3 z-10">
          <div className="text-sm font-medium">{selectedRowsCount} row(s) selected</div>
        </div>
      )}
    </div>
  );
}); 