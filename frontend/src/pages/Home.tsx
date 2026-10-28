import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Header } from '@/components/Home/Header';
import { LogSearch } from '@/components/Home/LogSearch';
import { LogViewer } from '@/components/Home/LogViewer/LogViewer';
import { LeftPanelContent, SIDEBAR_WIDTHS } from '@/components/Home/Sidebar/CollapsiblePanel';
import { SidebarPanel, type SidebarTabId } from '@/components/Home/SidebarPanel';
import { LeftRail } from '@/components/Shell/LeftRail';
import { StatusBar } from '@/components/Shell/StatusBar';
import { useCollapsiblePanel } from '@/hooks/useCollapsiblePanel';
import { isNativeShell } from '@/lib/native';
import Agent from '@/pages/Agent';
import { AGENT_PANEL_MIN, useAgentStore } from '@/stores/useAgentStore';
import { useFacetStore } from '@/stores/useFacetStore';
import { useLogResultStore } from '@/stores/useLogResultStore';
import useSearchQueryParamsStore from '@/stores/useSearchQueryParams';
import { useSidebarStore } from '@/stores/useSidebarStore';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

import './Home.css';

const SIDEBAR_WIDTH_STORAGE_KEY = 'logsonic-sidebar-width';
const RAIL_W = 56;
const TOPBAR_H = 44;
// Traffic lights are inset over the top-left corner in the native shell
// (macos-b1) -- only the brand cell + topbar's left edge widen to clear
// them; the vertical icon rail below the topbar and everything under it
// stay at RAIL_W, so only the very top row gets the inset.
//
// TRAFFIC_LIGHT_ZONE_W is dead space reserved for the OS-drawn traffic
// lights themselves (~20-72px from the window edge by default for a
// .fullSizeContentView window; no API exposes the exact cluster width, so
// this is a measured-generous estimate, not a constant Apple documents).
// The brand mark must not be centered across that whole span -- verified
// live (desktop-control session, 2026-09-03) that doing so lands the
// zoom button directly on the icon. Fixed by right-aligning the icon in
// the extra width added past the reserved zone instead.
const TRAFFIC_LIGHT_ZONE_W = 78;
const NATIVE_BRAND_CELL_W = 124;
const BRAND_ICON_W = 26; // must match BrandMark's own width/height below
const LogDistributionChart = lazy(() => import('@/components/Home/LogDistributionChart'));

const ChartLoadingShell = () => (
  <div
    style={{
      height: 76,
      background: 'var(--ls-panel)',
      borderBottom: '1px solid var(--ls-border)',
    }}
  >
    <div
      className="flex items-center px-3 font-medium"
      style={{ height: 28, fontSize: 11, color: 'var(--ls-text-2)' }}
    >
      Event distribution
    </div>
  </div>
);

const DeferredLogDistributionChart = () => {
  const hasFirstPage = useLogResultStore((state) => state.logData !== null);
  const [loadChart, setLoadChart] = useState(false);

  useEffect(() => {
    if (!hasFirstPage || loadChart) return;
    const timer = window.setTimeout(() => setLoadChart(true), 250);
    return () => window.clearTimeout(timer);
  }, [hasFirstPage, loadChart]);

  if (!loadChart) return <ChartLoadingShell />;
  return (
    <Suspense fallback={<ChartLoadingShell />}>
      <LogDistributionChart />
    </Suspense>
  );
};

const BrandMark = () => (
  <svg
    aria-hidden
    width={BRAND_ICON_W}
    height={BRAND_ICON_W}
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
 * Brand sits in the top-left 56×44 cell (124×44 in the native macOS shell —
 * the first 78px reserved for the inset traffic lights, the icon
 * right-aligned in the rest — macos-b1). The topbar spans the rest of the
 * top row, and the nav rail / main content sit below, always at 56px.
 */
const Home = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const agentOpen = useAgentStore((s) => s.panelOpen);
  const agentWidth = useAgentStore((s) => s.panelWidth);
  const setAgentOpen = useAgentStore((s) => s.setPanelOpen);
  const toggleAgent = useAgentStore((s) => s.togglePanel);
  const setAgentWidth = useAgentStore((s) => s.setPanelWidth);
  const [resizingAgent, setResizingAgent] = useState(false);
  // Below this width the dock covers the workspace (see Agent.css) instead of
  // squeezing the log table.
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 820px)').matches ?? false
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(max-width: 820px)');
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const agentDrag = useRef<{ x: number; width: number } | null>(null);
  const { isCollapsed, toggleCollapse: togglePanelCollapse } = useCollapsiblePanel(true);
  const { tabs } = SidebarPanel();
  const { firstLoad, setFirstLoad, triggerSearch } = useSearchQueryParamsStore();
  const native = isNativeShell();
  const brandCellWidth = native ? NATIVE_BRAND_CELL_W : RAIL_W;

  const [activeTabId, setActiveTabId] = useState<SidebarTabId>('filter');
  const setFacetPanelOpen = useFacetStore((s) => s.setPanelOpen);

  // The Fields panel's facets ride on the deferred metadata request only while
  // the panel is visible; keep the store informed of that.
  useEffect(() => {
    setFacetPanelOpen(!isCollapsed && activeTabId === 'fields');
    useSidebarStore.getState().setCurrent(activeTabId, !isCollapsed);
  }, [isCollapsed, activeTabId, setFacetPanelOpen]);

  // Apply an open/close request from outside Home (the agent bridge).
  const pendingSidebar = useSidebarStore((s) => s.pending);
  useEffect(() => {
    if (!pendingSidebar) return;
    const { panel, open } = pendingSidebar;
    useSidebarStore.getState().clearPending();
    if (open) {
      setActiveTabId(panel);
      if (isCollapsed) togglePanelCollapse();
    } else if (!isCollapsed && activeTabId === panel) {
      togglePanelCollapse();
    }
  }, [pendingSidebar, isCollapsed, activeTabId, togglePanelCollapse]);

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

  // #/agent is kept as a link that opens the agent dock over the log view.
  useEffect(() => {
    if (location.pathname === '/agent') {
      setAgentOpen(true);
      navigate('/', { replace: true });
    }
  }, [location.pathname, navigate, setAgentOpen]);

  // Cmd/Ctrl+J toggles the agent dock from anywhere on the log view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        toggleAgent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleAgent]);

  // Focus moves into the composer when the dock opens from the keyboard or rail.
  useEffect(() => {
    if (agentOpen) {
      window.requestAnimationFrame(() => document.getElementById('ls-agent-input')?.focus());
    }
  }, [agentOpen]);

  const startAgentResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    agentDrag.current = { x: event.clientX, width: agentWidth };
    setResizingAgent(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveAgentResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!agentDrag.current) return;
    const maxForWindow = window.innerWidth - RAIL_W - 420;
    const next = agentDrag.current.width + (agentDrag.current.x - event.clientX);
    setAgentWidth(Math.min(next, Math.max(AGENT_PANEL_MIN, maxForWindow)));
  };
  const endAgentResize = () => {
    agentDrag.current = null;
    setResizingAgent(false);
  };

  // An agent import adds sources: reload the catalog so the source filter
  // includes them, then rerun the search.
  const refreshAfterImport = useCallback(() => {
    void useSystemInfoStore
      .getState()
      .refreshSystemInfo(true)
      .catch(() => undefined)
      .then(() => triggerSearch());
  }, [triggerSearch]);

  const sidebarTotalWidth = isCollapsed ? 0 : sidebarWidth;
  const marginLeft = RAIL_W + sidebarTotalWidth;
  const marginRight = agentOpen && !narrow ? agentWidth : 0;

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

  const toggleFields = useCallback(() => {
    if (activeTabId === 'fields' && !isCollapsed) {
      togglePanelCollapse();
    } else {
      setActiveTabId('fields');
      if (isCollapsed) togglePanelCollapse();
    }
  }, [activeTabId, isCollapsed, togglePanelCollapse]);

  const toggleSources = useCallback(() => {
    if (activeTabId === 'sources' && !isCollapsed) {
      togglePanelCollapse();
    } else {
      setActiveTabId('sources');
      if (isCollapsed) togglePanelCollapse();
    }
  }, [activeTabId, isCollapsed, togglePanelCollapse]);

  return (
    <div
      className="ls-workspace h-screen overflow-hidden"
      style={{ background: 'var(--ls-bg-1)', color: 'var(--ls-text)' }}
    >
      {/* Brand cell — top-left 56×44 (78×44 native, clearing the inset
          traffic lights), with right + bottom borders. Not a button/input/
          etc, so it's draggable by default under the native drag-strip hook. */}
      <div
        data-native-drag="true"
        className="ls-native-chrome"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: brandCellWidth,
          height: TOPBAR_H,
          borderRight: '1px solid var(--ls-border)',
          borderBottom: '1px solid var(--ls-border)',
          background: 'var(--ls-panel)',
          display: 'flex',
          alignItems: 'center',
          // Centering across the full width would land the icon on top of
          // the traffic lights in native mode (verified live) -- push it
          // past TRAFFIC_LIGHT_ZONE_W instead, with an 8px safety margin
          // past that estimate since no API exposes the exact cluster
          // width. Browser mode has no reserved zone, so centering the
          // full (narrower) cell is correct there.
          justifyContent: native ? 'flex-end' : 'center',
          paddingRight: native ? brandCellWidth - TRAFFIC_LIGHT_ZONE_W - 8 - BRAND_ICON_W : 0,
          zIndex: 70,
        }}
      >
        <BrandMark />
      </div>

      {/* Topbar — spans the row right of the brand */}
      <div
        className="ls-native-chrome"
        style={{
          position: 'fixed',
          top: 0,
          left: brandCellWidth,
          right: 0,
          height: TOPBAR_H,
          background: 'var(--ls-panel)',
          borderBottom: '1px solid var(--ls-border)',
          zIndex: 60,
        }}
      >
        <Header
          activeSection={isCollapsed ? null : activeTabId}
          agentOpen={agentOpen}
          onToggleAgent={toggleAgent}
        />
      </div>

      {/* Nav rail — below the brand */}
      <div
        className="ls-native-chrome"
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
          fieldsOpen={!isCollapsed && activeTabId === 'fields'}
          sourcesOpen={!isCollapsed && activeTabId === 'sources'}
          coloringOpen={!isCollapsed && activeTabId === 'styling'}
          onToggleFilter={toggleFilter}
          onToggleFields={toggleFields}
          onToggleSources={toggleSources}
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
        onActiveTabChange={(id) => setActiveTabId(id as SidebarTabId)}
      />

      {/* Main content — offset for rail + sidebar on the left, topbar above */}
      <div
        className="flex flex-col"
        style={{
          marginLeft: `${marginLeft}px`,
          marginRight: `${marginRight}px`,
          marginTop: `${TOPBAR_H}px`,
          height: `calc(100vh - ${TOPBAR_H}px)`,
          transition: resizingAgent ? undefined : 'margin-left 0.3s, margin-right 0.2s',
        }}
      >
        <div className="flex-1 overflow-hidden flex flex-col">
          <div
            className="ls-workspace-controls"
            style={{
              background: 'var(--ls-panel)',
              borderBottom: '1px solid var(--ls-border)',
            }}
          >
            <div className="ls-search-surface">
              <LogSearch />
            </div>
          </div>

          <DeferredLogDistributionChart />

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

      {agentOpen && (
        <aside
          className="ls-agent-dock"
          style={{ top: TOPBAR_H, width: agentWidth }}
          aria-label="Agent panel"
        >
          <div
            className={`ls-agent-dock-resize${resizingAgent ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent panel"
            aria-valuemin={AGENT_PANEL_MIN}
            aria-valuenow={agentWidth}
            tabIndex={0}
            onPointerDown={startAgentResize}
            onPointerMove={moveAgentResize}
            onPointerUp={endAgentResize}
            onPointerCancel={endAgentResize}
            onLostPointerCapture={endAgentResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') setAgentWidth(agentWidth + 24);
              if (event.key === 'ArrowRight') setAgentWidth(agentWidth - 24);
            }}
          />
          <Agent onClose={() => setAgentOpen(false)} onDataChanged={refreshAfterImport} />
        </aside>
      )}
    </div>
  );
};

export default Home;
