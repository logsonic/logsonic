import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, FilterX, Palette } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';

// Sidebar width constants - adjust these values to change all sidebar dimensions
export const SIDEBAR_WIDTHS = {
  COLLAPSED: 64,  // Width in pixels when sidebar is collapsed
  EXPANDED: 400   // Width in pixels when sidebar is expanded
};

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 640;

// Tailwind classes for sidebar widths
const SIDEBAR_WIDTH_CLASSES = {
  COLLAPSED: "w-[64px]",
};

// Props for the collapsible panel toggle button
export type CollapsePanelButtonProps = {
  isCollapsed: boolean;
  onClick: () => void;
};

/**
 * Button component for toggling panel collapse state
 */
export const CollapsePanelButton = ({ isCollapsed, onClick }: CollapsePanelButtonProps) => {
  const baseClasses = "h-6 w-6 text-slate-600 hover:text-slate-900 hover:bg-slate-100";
  const positionClasses = isCollapsed ? "absolute top-2 right-2 z-10" : "absolute top-2 right-2 z-10";
  
  return (
    <Button 
      variant="ghost" 
      size="icon" 
      onClick={onClick}
      className={`${baseClasses} ${positionClasses}`}
      aria-label={isCollapsed ? "Expand panel" : "Collapse panel"}
    >
      {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
    </Button>
  );
};

// Vertical tab interface
export type VerticalTab = {
  id: string;
  icon: React.ReactNode;
  label: string;
  content: React.ReactNode;
};

// Props for the left panel content
export type LeftPanelContentProps = {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  children?: ReactNode;
  tabs?: VerticalTab[];
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  /** Pixels to offset the panel from the left edge (e.g. for a rail) */
  leftOffset?: number;
  /** Pixels to offset the panel from the top (e.g. for a topbar) */
  topOffset?: number;
  /** Controlled active tab id */
  activeTabId?: string;
  /** Notifies when active tab changes (controlled mode) */
  onActiveTabChange?: (id: string) => void;
};

/**
 * Content container for the left panel with collapse functionality and vertical tabs
 */
export const LeftPanelContent = ({
  isCollapsed,
  onToggleCollapse,
  children,
  tabs = [],
  sidebarWidth,
  onSidebarWidthChange,
  leftOffset = 0,
  topOffset = 0,
  activeTabId,
  onActiveTabChange,
}: LeftPanelContentProps) => {
  const [internalActiveTab, setInternalActiveTab] = useState<string>(tabs.length > 0 ? tabs[0].id : '');
  const activeTab = activeTabId ?? internalActiveTab;
  const setActiveTab = (id: string) => {
    if (activeTabId === undefined) setInternalActiveTab(id);
    onActiveTabChange?.(id);
  };

  // Default tabs if none provided
  const defaultTabs: VerticalTab[] = [
    {
      id: 'filter',
      icon: <FilterX className="h-4 w-4" />,
      label: 'Filter',
      content: children
    },
    {
      id: 'styling',
      icon: <Palette className="h-4 w-4" />,
      label: 'Styling',
      content: null
    }
  ];

  const tabsToUse = tabs.length > 0 ? tabs : defaultTabs;
  const effectiveExpandedWidth = sidebarWidth ?? SIDEBAR_WIDTHS.EXPANDED;

  // Handle tab selection in collapsed state
  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    if (isCollapsed) {
      onToggleCollapse();
    }
  };

  // Set a CSS variable for the sidebar width
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--sidebar-width',
      isCollapsed
        ? `${SIDEBAR_WIDTHS.COLLAPSED}px`
        : `${effectiveExpandedWidth}px`
    );
  }, [isCollapsed, effectiveExpandedWidth]);

  // Resize drag handle logic
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(effectiveExpandedWidth);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = effectiveExpandedWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidthRef.current + delta));
      onSidebarWidthChange?.(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [effectiveExpandedWidth, onSidebarWidthChange]);

  const currentWidth = isCollapsed ? SIDEBAR_WIDTHS.COLLAPSED : effectiveExpandedWidth;

  // When a rail provides the toggle, render nothing while collapsed —
  // the rail covers expand/coloring actions, so a separate icon column would duplicate it.
  if (leftOffset > 0 && isCollapsed) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed bottom-0 z-50 transition-[width] duration-300",
        isCollapsed ? SIDEBAR_WIDTH_CLASSES.COLLAPSED : undefined
      )}
      style={{
        top: `${topOffset}px`,
        left: `${leftOffset}px`,
        width: isCollapsed ? `${SIDEBAR_WIDTHS.COLLAPSED}px` : `${effectiveExpandedWidth}px`,
        background: 'var(--ls-panel)',
        borderRight: '1px solid var(--ls-border)',
        boxShadow: 'var(--ls-shadow-sm)',
      }}
    >
      <div className="h-full flex flex-col">
        {/* Section header — sticky title for the active panel (matches design's .facets-header) */}
        <div
          className="flex items-center justify-between px-3 flex-shrink-0"
          style={{
            height: 36,
            borderBottom: '1px solid var(--ls-border)',
            background: 'var(--ls-panel)',
          }}
        >
          {isCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              className="h-6 w-6 mx-auto"
              style={{ color: 'var(--ls-text-2)' }}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}

          {!isCollapsed && (
            <span
              className="font-semibold flex-1 truncate"
              style={{
                fontSize: 11,
                color: 'var(--ls-text-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {tabsToUse.find(tab => tab.id === activeTab)?.label}
            </span>
          )}

          {!isCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              className="h-6 w-6 flex-shrink-0"
              style={{ color: 'var(--ls-text-2)' }}
              aria-label="Collapse"
              title="Collapse sidebar"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Tab navigation area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Vertical tab navigation - hide when leftOffset is set (rail provides nav) */}
          {(isCollapsed || leftOffset === 0) && (
            <div
              className={cn(
                "pt-3 flex flex-col items-center flex-shrink-0",
                isCollapsed ? "w-full" : "w-14"
              )}
              style={{
                background: 'var(--ls-panel)',
                borderRight: !isCollapsed ? '1px solid var(--ls-border-subtle)' : undefined,
              }}
            >
              {tabsToUse.map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 mb-2 relative rounded-lg transition-all"
                  style={
                    activeTab === tab.id
                      ? {
                          background: 'var(--ls-accent-soft)',
                          color: 'var(--ls-accent-text)',
                        }
                      : { color: 'var(--ls-text-3)' }
                  }
                  onClick={() => handleTabClick(tab.id)}
                  aria-label={tab.label}
                  title={tab.label}
                >
                  {tab.icon}
                  {activeTab === tab.id && !isCollapsed && (
                    <div
                      className="absolute right-0 top-[20%] bottom-[20%] rounded-full"
                      style={{ width: 2, background: 'var(--ls-accent)' }}
                    />
                  )}
                </Button>
              ))}
            </div>
          )}

          {/* Tab content */}
          {!isCollapsed && (
            <div
              className="flex-1 p-3 overflow-auto min-w-0"
              style={{ background: 'var(--ls-panel)' }}
            >
              {tabsToUse.map((tab) => (
                activeTab === tab.id && (
                  <div key={tab.id} className="h-full">
                    {tab.content}
                  </div>
                )
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Resize drag handle - only visible when expanded */}
      {!isCollapsed && onSidebarWidthChange && (
        <div
          className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize group transition-colors z-10"
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize sidebar"
          style={{ background: 'transparent' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ls-accent-softer)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <div
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ width: 2, height: 48, background: 'var(--ls-accent)' }}
          />
        </div>
      )}
    </div>
  );
};