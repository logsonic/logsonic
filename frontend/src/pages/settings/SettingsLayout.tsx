import { ArrowLeft, Info, Settings as SettingsIcon, SlidersHorizontal, Terminal } from 'lucide-react';
import { FC, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/lib/error-boundary';

type NavItem = {
  id: string;
  label: string;
  path: string;
  icon: ReactNode;
};

// Only sections backed by real functionality — no mock controls.
const NAV: NavItem[] = [
  {
    id: 'patterns',
    label: 'Custom patterns',
    path: '/settings/patterns',
    icon: <SlidersHorizontal size={14} />,
  },
  {
    id: 'mcp',
    label: 'MCP Integration',
    path: '/settings/mcp',
    icon: <Terminal size={14} />,
  },
  {
    id: 'about',
    label: 'About',
    path: '/settings/about',
    icon: <Info size={14} />,
  },
];

interface SettingsLayoutProps {
  children: ReactNode;
}

/**
 * Shared chrome for every settings sub-route: topbar, page header, and the
 * sticky left nav. Recreated from the Claude Design settings mock (two-pane
 * `settings-grid` + `settings-nav`). The active nav item is derived from the
 * current route, so each section remains a real, deep-linkable subpage.
 */
export const SettingsLayout: FC<SettingsLayoutProps> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <ErrorBoundary fallback={<div>Error loading settings</div>}>
      <div
        className="min-h-screen"
        style={{ background: 'var(--ls-bg-1)', color: 'var(--ls-text)' }}
      >
        {/* Top bar — mirrors the Import header */}
        <div
          className="flex items-center justify-between"
          style={{
            height: 'var(--ls-topbar-h)',
            padding: '0 14px',
            background: 'var(--ls-panel)',
            borderBottom: '1px solid var(--ls-border)',
          }}
        >
          <div className="flex items-center" style={{ gap: 6, fontSize: 13, fontWeight: 500 }}>
            <span style={{ color: 'var(--ls-text-3)' }}>LogSonic</span>
            <span style={{ color: 'var(--ls-text-4)', margin: '0 6px' }}>/</span>
            <span style={{ color: 'var(--ls-text)' }}>Settings</span>
          </div>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center transition-colors"
            style={{
              gap: 6,
              height: 28,
              padding: '0 10px',
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid var(--ls-border)',
              color: 'var(--ls-text-2)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ls-bg-2)';
              e.currentTarget.style.color = 'var(--ls-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--ls-text-2)';
            }}
            aria-label="Back to Home"
          >
            <ArrowLeft size={13} />
            <span>Back to home</span>
          </button>
        </div>

        {/* Page body */}
        <div className="w-full mx-auto" style={{ maxWidth: 1100, padding: '28px 24px 48px' }}>
          {/* Page header */}
          <div className="flex items-center" style={{ gap: 12, marginBottom: 24 }}>
            <div
              className="inline-flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'var(--ls-accent-soft)',
                border: '1px solid var(--ls-accent-border)',
              }}
            >
              <SettingsIcon size={18} style={{ color: 'var(--ls-accent)' }} />
            </div>
            <div>
              <h1
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: 'var(--ls-text)',
                  letterSpacing: '-0.015em',
                  lineHeight: 1.2,
                }}
              >
                Settings
              </h1>
              <p style={{ fontSize: 12.5, color: 'var(--ls-text-3)', marginTop: 2 }}>
                Manage your local LogSonic instance.
              </p>
            </div>
          </div>

          {/* Two-pane grid: sticky nav + content */}
          <div className="ls-set-grid">
            <nav className="ls-set-nav">
              {NAV.map((item) => {
                const active = location.pathname === item.path;
                return (
                  <a
                    key={item.id}
                    className={active ? 'active' : ''}
                    onClick={() => navigate(item.path)}
                  >
                    {item.icon}
                    {item.label}
                  </a>
                );
              })}
            </nav>

            <div>{children}</div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default SettingsLayout;
