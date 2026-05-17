import { Header } from '@/components/Home/Header';
import LogDistributionChart from '@/components/Home/LogDistributionChart';
import { LogSearch } from '@/components/Home/LogSearch';
import { LogViewer } from '@/components/Home/LogViewer/LogViewer';
import { LeftPanelContent, SIDEBAR_WIDTHS } from '@/components/Home/Sidebar/CollapsiblePanel';
import { SidebarPanel } from '@/components/Home/SidebarPanel';
import { LeftRail } from '@/components/Shell/LeftRail';
import { StatusBar } from '@/components/Shell/StatusBar';
import { useCollapsiblePanel } from '@/hooks/useCollapsiblePanel';
import useSearchQueryParamsStore from '@/stores/useSearchQueryParams';
import { useCallback, useEffect, useState } from 'react';

const SIDEBAR_WIDTH_STORAGE_KEY = 'logsonic-sidebar-width';
const RAIL_W = 56;
const TOPBAR_H = 44;

const BrandMark = () => (
  <svg
    aria-hidden
    width={26}
    height={26}
    viewBox="0 0 100 100"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'block' }}
  >
    <rect width="100" height="100" rx="19" ry="19" fill="#6d5dfc" />
    <path
      d="M44.59,15.72h22.44s-13.71,27.99-13.71,27.99l1,.26,21.09-.04c1.63.52.87,1.24.14,2.06-7.01,7.94-15.19,15.94-22.6,23.69-4.5,4.71-9.06,9.39-13.53,14.12-1.93,1.48-3.65-.86-2.98-2.46l9.45-26.21.02-.06h-21.29c-.54-.07-.93-.39-1-.86-.07-.44,1.42-2.96,1.74-3.56,6.24-11.71,13.03-23.22,19.24-34.94Z"
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={5}
    />
  </svg>
);

/**
 * Home page using the redesign shell:
 *   "brand  topbar"
 *   "nav    main"
 * Brand sits in the top-left 56×44 cell. The topbar spans the rest of the
 * top row, and the nav rail / main content sit below.
 */
const Home = () => {
  const { isCollapsed, toggleCollapse: togglePanelCollapse } = useCollapsiblePanel(true);
  const { tabs } = SidebarPanel();
  const { firstLoad, setFirstLoad, triggerSearch } = useSearchQueryParamsStore();

  const [activeTabId, setActiveTabId] = useState<string>('filter');

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

  const sidebarTotalWidth = isCollapsed ? 0 : sidebarWidth;
  const marginLeft = RAIL_W + sidebarTotalWidth;

  const toggleFilter = useCallback(() => {
    if (activeTabId === 'filter' && !isCollapsed) {
      togglePanelCollapse();
    } else {
      setActiveTabId('filter');
      if (isCollapsed) togglePanelCollapse();
    }
  }, [activeTabId, isCollapsed, togglePanelCollapse]);

  const toggleColoring = useCallback(() => {
    if (activeTabId === 'styling' && !isCollapsed) {
      togglePanelCollapse();
    } else {
      setActiveTabId('styling');
      if (isCollapsed) togglePanelCollapse();
    }
  }, [activeTabId, isCollapsed, togglePanelCollapse]);

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ background: 'var(--ls-bg-1)', color: 'var(--ls-text)' }}
    >
      {/* Brand cell — top-left 56×44, with right + bottom borders */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: RAIL_W,
          height: TOPBAR_H,
          borderRight: '1px solid var(--ls-border)',
          borderBottom: '1px solid var(--ls-border)',
          background: 'var(--ls-panel)',
          display: 'grid',
          placeItems: 'center',
          zIndex: 70,
        }}
      >
        <BrandMark />
      </div>

      {/* Topbar — spans the row right of the brand */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: RAIL_W,
          right: 0,
          height: TOPBAR_H,
          background: 'var(--ls-panel)',
          borderBottom: '1px solid var(--ls-border)',
          zIndex: 60,
        }}
      >
        <Header activeSection={isCollapsed ? null : (activeTabId as 'filter' | 'styling')} />
      </div>

      {/* Nav rail — below the brand */}
      <div
        style={{
          position: 'fixed',
          top: TOPBAR_H,
          left: 0,
          bottom: 0,
          width: RAIL_W,
          zIndex: 60,
        }}
      >
        <LeftRail
          filterOpen={!isCollapsed && activeTabId === 'filter'}
          coloringOpen={!isCollapsed && activeTabId === 'styling'}
          onToggleFilter={toggleFilter}
          onToggleColoring={toggleColoring}
        />
      </div>

      {/* Filter / styling panel — starts below the topbar */}
      <LeftPanelContent
        isCollapsed={isCollapsed}
        onToggleCollapse={togglePanelCollapse}
        tabs={tabs}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={handleSidebarWidthChange}
        leftOffset={RAIL_W}
        topOffset={TOPBAR_H}
        activeTabId={activeTabId}
        onActiveTabChange={setActiveTabId}
      />

      {/* Main content — offset for rail + sidebar on the left, topbar above */}
      <div
        className="flex flex-col"
        style={{
          marginLeft: `${marginLeft}px`,
          marginTop: `${TOPBAR_H}px`,
          height: `calc(100vh - ${TOPBAR_H}px)`,
          transition: isCollapsed ? 'margin-left 0.3s' : undefined,
        }}
      >
        <div className="flex-1 overflow-hidden flex flex-col">
          <div
            className="px-3 py-2"
            style={{
              background: 'var(--ls-panel)',
              borderBottom: '1px solid var(--ls-border)',
            }}
          >
            <LogSearch />
          </div>

          <LogDistributionChart />

          <div
            className="flex-1 flex flex-col overflow-hidden"
            style={{
              background: 'var(--ls-panel)',
              borderTop: '1px solid var(--ls-border)',
            }}
          >
            <LogViewer />
          </div>
        </div>

        <StatusBar />
      </div>
    </div>
  );
};

export default Home;
