import { LeftPanelContent, SIDEBAR_WIDTHS } from '@/components/Home/Sidebar/CollapsiblePanel';
import { Header } from '@/components/Home/Header';
import { useCollapsiblePanel } from '@/hooks/useCollapsiblePanel';
import { LogSearch } from '@/components/Home/LogSearch';
import { LogViewer } from '@/components/Home/LogViewer/LogViewer';
import { SidebarPanel } from '@/components/Home/SidebarPanel';
import LogDistributionChart from '@/components/Home/LogDistributionChart';
import useSearchQueryParamsStore from '@/stores/useSearchQueryParams';
import { useEffect } from 'react';

/**
 * Home page component with sidebar and main content
 */
const Home = () => {
  // Use our custom hook for panel collapse management
  const { isCollapsed, toggleCollapse: togglePanelCollapse } = useCollapsiblePanel(true);

  // Get sidebar tabs from SidebarPanel component
  const { tabs } = SidebarPanel();

  const { firstLoad, setFirstLoad, triggerSearch } = useSearchQueryParamsStore();
 
  useEffect(() => {
    if (firstLoad) {

      setFirstLoad(false);
      triggerSearch();
    }
  }, [firstLoad, setFirstLoad, triggerSearch]);

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Sidebar */}
      <LeftPanelContent 
        isCollapsed={isCollapsed} 
        onToggleCollapse={togglePanelCollapse}
        tabs={tabs}
      />
      
      {/* Main content with margin to accommodate sidebar */}
      <div 
        className="flex-1 transition-all duration-300"
        style={{ 
          marginLeft: isCollapsed 
            ? `${SIDEBAR_WIDTHS.COLLAPSED}px` 
            : `${SIDEBAR_WIDTHS.EXPANDED}px` 
        }}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <Header />

          {/* Main content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Search bar */}
            <div className="py-2 px-3 bg-white">
              <LogSearch />
            </div>

            {/* Chart */}
            <LogDistributionChart />

            {/* Log viewer */}
            <div className="flex-1 bg-white m-3 rounded-lg flex flex-col border">
              <LogViewer />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
