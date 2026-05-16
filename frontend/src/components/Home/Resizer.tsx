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
      {/* Resize handle — absolutely pinned to the column's right edge */}
      <div
        className={`absolute top-0 right-0 h-full cursor-col-resize group/resizer ${isResizing ? 'z-10' : ''}`}
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 6 }}
      >
        <span
          aria-hidden
          className={`block h-full transition-colors ${isResizing ? '' : 'opacity-0 group-hover/resizer:opacity-100'}`}
          style={{
            width: 2,
            marginLeft: 2,
            background: isResizing ? 'var(--ls-accent)' : 'var(--ls-border-strong)',
          }}
        />
      </div>

      {/* Overlay when resizing */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </>
  );
};
