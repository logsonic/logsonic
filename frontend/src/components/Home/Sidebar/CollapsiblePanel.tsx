import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, FilterX, Palette, Home } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// Sidebar width constants - adjust these values to change all sidebar dimensions
export const SIDEBAR_WIDTHS = {
  COLLAPSED: 64,  // Width in pixels when sidebar is collapsed
  EXPANDED: 400   // Width in pixels when sidebar is expanded
};

// Tailwind classes for sidebar widths
const SIDEBAR_WIDTH_CLASSES = {
  COLLAPSED: "w-[64px]",
  EXPANDED: "w-[400px]"
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
};

/**
 * Content container for the left panel with collapse functionality and vertical tabs
 */
export const LeftPanelContent = ({ 
  isCollapsed, 
  onToggleCollapse, 
  children,
  tabs = []
}: LeftPanelContentProps) => {
  const [activeTab, setActiveTab] = useState<string>(tabs.length > 0 ? tabs[0].id : '');

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

  // Handle tab selection in collapsed state
  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    // Expand the panel when a tab is clicked in collapsed state
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
        : `${SIDEBAR_WIDTHS.EXPANDED}px`
    );
  }, [isCollapsed]);

  return (
    <div className={cn(
      "h-full bg-white border-r border-slate-200 shadow-sm fixed left-0 top-0 bottom-0 z-50 transition-all duration-300",
      isCollapsed 
        ? SIDEBAR_WIDTH_CLASSES.COLLAPSED
        : SIDEBAR_WIDTH_CLASSES.EXPANDED
    )}>
      <div className="h-full flex flex-col">
        {/* Header area - consistent in both states */}
        <div className="h-12 flex items-center justify-between px-3 border-b border-slate-200 bg-white">
          {/* Logo/Expand button - only visible when collapsed */}
          {isCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              className="h-8 w-8 border border-slate-200 rounded-md text-slate-700 hover:text-slate-900 hover:bg-slate-100 mx-auto"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
          
          {/* Title - only visible when expanded */}
          {!isCollapsed && (
            <span className="text-sm font-medium flex-1 truncate">
              {tabsToUse.find(tab => tab.id === activeTab)?.label}
            </span>
          )}
          
          {/* Collapse button - only visible when expanded */}
          {!isCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              className="h-8 w-8 border border-slate-200 rounded-md text-slate-700 hover:text-slate-900 hover:bg-slate-100"
              aria-label="Collapse"
              title="Collapse sidebar"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
        
        {/* Tab navigation area - consistent structure in both states */}
        <div className="flex flex-1 overflow-hidden">
          {/* Vertical tab navigation - always visible */}
          <div className={cn(
            "pt-4 flex flex-col items-center bg-white",
            isCollapsed ? "w-full" : "w-16 border-r border-slate-200"
          )}>
            {tabsToUse.map((tab) => (
              <Button
                key={tab.id}
                variant="ghost"
                size="icon"
                className={cn(
                  "h-10 w-10 mb-3 relative border border-slate-200 rounded-md transition-all",
                  activeTab === tab.id 
                    ? "bg-blue-50/70 text-blue-700 border-slate-200" 
                    : "text-slate-700 hover:bg-slate-100"
                )}
                onClick={() => handleTabClick(tab.id)}
                aria-label={tab.label}
                title={tab.label}
              >
                {tab.icon}
                {activeTab === tab.id && (
                  <div className="absolute top-[15%] right-0 bottom-[15%] w-[2px] bg-blue-400 rounded-full"></div>
                )}
              </Button>
            ))}
          </div>
          
          {/* Tab content - only visible when expanded */}
          {!isCollapsed && (
            <div className="flex-1 p-2 overflow-auto bg-white">
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
    </div>
  );
}; 