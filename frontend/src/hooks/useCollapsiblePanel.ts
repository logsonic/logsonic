import { useCallback, useState } from 'react';

/**
 * Custom hook for managing collapsible panel state and actions
 * 
 * @param initialCollapsed - Whether the panel should start collapsed
 * @returns Object containing panel state and handlers
 */
export function useCollapsiblePanel(initialCollapsed = true) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);

  // Simple toggle function that directly updates state
  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const handleExpand = useCallback(() => {
    setIsCollapsed(false);
  }, []);

  // Handlers for panel events
  const handleCollapse = useCallback(() => {
    setIsCollapsed(true);
  }, []);

  // Keep reference for backward compatibility
  const panelRef = { current: null };

  return {
    isCollapsed,
    panelRef,
    toggleCollapse,
    handleCollapse,
    handleExpand
  };
} 