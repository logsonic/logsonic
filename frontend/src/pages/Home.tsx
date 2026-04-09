import { Header } from '@/components/Home/Header';
import LogDistributionChart from '@/components/Home/LogDistributionChart';
import { LogSearch } from '@/components/Home/LogSearch';
import { LogViewer } from '@/components/Home/LogViewer/LogViewer';
import { LeftPanelContent, SIDEBAR_WIDTHS } from '@/components/Home/Sidebar/CollapsiblePanel';
import { SidebarPanel } from '@/components/Home/SidebarPanel';
import { useCollapsiblePanel } from '@/hooks/useCollapsiblePanel';
import useSearchQueryParamsStore from '@/stores/useSearchQueryParams';
import { useCallback, useEffect, useState } from 'react';

const SIDEBAR_WIDTH_STORAGE_KEY = 'logsonic-sidebar-width';

/**
 * Home page component with sidebar and main content
 */
const Home = () => {
  const { isCollapsed, toggleCollapse: togglePanelCollapse } = useCollapsiblePanel(true);
  const { tabs } = SidebarPanel();
  const { firstLoad, setFirstLoad, triggerSearch } = useSearchQueryParamsStore();

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return saved ? Math.max(240, Math.min(640, parseInt(saved, 10))) : SIDEBAR_WIDTHS.EXPANDED;
  });

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  }, []);

  useEffect(() => {
    if (firstLoad) {
      setFirstLoad(false);
      triggerSearch();
    }
  }, [firstLoad, setFirstLoad, triggerSearch]);

  const marginLeft = isCollapsed ? SIDEBAR_WIDTHS.COLLAPSED : sidebarWidth;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Sidebar */}
      <LeftPanelContent
        isCollapsed={isCollapsed}
        onToggleCollapse={togglePanelCollapse}
        tabs={tabs}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={handleSidebarWidthChange}
      />

      {/* Main content with margin to accommodate sidebar */}
      <div
        className="flex-1"
        style={{
          marginLeft: `${marginLeft}px`,
          transition: isCollapsed ? 'margin-left 0.3s' : undefined,
        }}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <Header />

          {/* Main content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Search bar */}
            <div className="py-2 px-3 bg-white border-b border-slate-100">
              <LogSearch />
            </div>

            {/* Chart */}
            <LogDistributionChart />

            {/* Log viewer */}
            <div className="flex-1 bg-white mx-3 mb-3 rounded-lg flex flex-col border border-slate-200 shadow-sm overflow-hidden">
              <LogViewer />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
