import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import React, { useEffect, useState } from 'react';

// Fixed columns that should not be included in width calculations
const fixedColumns = ['select', 'expander'];

interface ResizerProps {
  columnId: string;
}

export const Resizer: React.FC<ResizerProps> = ({ columnId }) => {
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(0);
  const store = useSearchQueryParamsStore();

  // Mouse down handler to start resizing
  const handleMouseDown = (e: React.MouseEvent) => {
    if (store.isColumnLocked) return;
    
    // Stop event propagation so it doesn't trigger sorting
    e.preventDefault();
    e.stopPropagation();

    // Get parent cell width
    const headerCell = e.currentTarget.parentElement?.closest('th');
    if (!headerCell) return;

    const width = headerCell.getBoundingClientRect().width;

    setIsResizing(true);
    setStartX(e.clientX);
    setStartWidth(width);
  };

  // Handle resizing
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const delta = e.clientX - startX;
      const newWidth = Math.max(100, startWidth + delta);
      
      // Update column width in the store
      const newWidths = { ...store.columnWidths };
      newWidths[columnId] = newWidth;

      // Get all visible columns from the table
      const table = document.querySelector('table');
      if (!table) return;

      const headerCells = table.querySelectorAll('th');
      const visibleColumns = Array.from(headerCells)
        .map(cell => cell.getAttribute('data-column-id'))
        .filter((id): id is string => id !== null && !fixedColumns.includes(id));

      // Calculate total width of all columns except the last one
      let totalWidth = 0;
      visibleColumns.forEach((colId, index) => {
        if (index < visibleColumns.length - 1) {
          totalWidth += newWidths[colId] || 150; // Use default width if not set
        }
      });

      // Get table width
      const tableWidth = table.getBoundingClientRect().width;
      
      // Set the last column width to fill remaining space
      const lastColumnId = visibleColumns[visibleColumns.length - 1];
      if (lastColumnId) {
        newWidths[lastColumnId] = Math.max(100, tableWidth - totalWidth);
      }

      store.setColumnWidths(newWidths);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, startX, startWidth, columnId, store]);

  return (
    <>
      {/* Resizer handle */}
      <div
        className={`h-full w-4 cursor-col-resize group/resizer flex items-center justify-center ${isResizing ? 'z-10' : ''}`}
        onMouseDown={handleMouseDown}
        style={{ marginRight: '4px' }}
      >
        <svg 
          width="18" 
          height="18" 
          viewBox="0 0 15 15" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg"
          className={`opacity-30 group-hover/header:opacity-100 group-hover/resizer:opacity-100 transition-opacity duration-200 ${isResizing ? 'opacity-100' : ''}`}
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.00012 1.5C8.00012 1.22386 7.77626 1 7.50012 1C7.22398 1 7.00012 1.22386 7.00012 1.5V13.5C7.00012 13.7761 7.22398 14 7.50012 14C7.77626 14 8.00012 13.7761 8.00012 13.5V1.5ZM3.31812 5.818C3.49386 5.64227 3.49386 5.35734 3.31812 5.18161C3.14239 5.00587 2.85746 5.00587 2.68173 5.18161L0.681729 7.18161C0.505993 7.35734 0.505993 7.64227 0.681729 7.818L2.68173 9.818C2.85746 9.99374 3.14239 9.99374 3.31812 9.818C3.49386 9.64227 3.49386 9.35734 3.31812 9.18161L2.08632 7.9498H5.50017C5.7487 7.9498 5.95017 7.74833 5.95017 7.4998C5.95017 7.25128 5.7487 7.0498 5.50017 7.0498H2.08632L3.31812 5.818ZM12.3181 5.18161C12.1424 5.00587 11.8575 5.00587 11.6817 5.18161C11.506 5.35734 11.506 5.64227 11.6817 5.818L12.9135 7.0498H9.50017C9.25164 7.0498 9.05017 7.25128 9.05017 7.4998C9.05017 7.74833 9.25164 7.9498 9.50017 7.9498H12.9135L11.6817 9.18161C11.506 9.35734 11.506 9.64227 11.6817 9.818C11.8575 9.99374 12.1424 9.99374 12.3181 9.818L14.3181 7.818C14.4939 7.64227 14.4939 7.35734 14.3181 7.18161L12.3181 5.18161Z"
            fill={isResizing ? "#3b82f6" : "#6b7280"}
            stroke={isResizing ? "#3b82f6" : "#6b7280"}
            strokeWidth="0.2"
          />
        </svg>
      </div>

      {/* Overlay when resizing */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </>
  );
}; 