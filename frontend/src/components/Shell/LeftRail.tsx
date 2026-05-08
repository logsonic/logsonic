import { cn } from '@/lib/utils';
import { Bell, Bookmark, Eye, Filter, List, Settings, Upload, Zap } from 'lucide-react';
import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

type RailEntry = {
  id: string;
  icon: ReactNode;
  label: string;
  path?: string;
  onClick?: () => void;
  active?: boolean;
};

interface LeftRailProps {
  /** Optional secondary state (e.g. filter panel open) shown as active when route matches */
  filterOpen?: boolean;
  coloringOpen?: boolean;
  onToggleFilter?: () => void;
  onToggleColoring?: () => void;
  onToggleTweaks?: () => void;
}

export const LeftRail = ({
  filterOpen,
  coloringOpen,
  onToggleFilter,
  onToggleColoring,
  onToggleTweaks,
}: LeftRailProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname || '/';
  const isHome = path === '/' || path.startsWith('/?') || path.startsWith('/#');
  const isImport = path.startsWith('/import');
  const isSaved = path.startsWith('/saved');
  const isSettings = path.startsWith('/settings');
  const isAlerts = path.startsWith('/alerts');

  const primary: RailEntry[] = [
    {
      id: 'logs',
      icon: <List size={18} strokeWidth={1.7} />,
      label: 'Logs',
      onClick: () => navigate('/'),
      active: isHome && !coloringOpen,
    },
    {
      id: 'filter',
      icon: <Filter size={18} strokeWidth={1.7} />,
      label: 'Filters',
      onClick: () => onToggleFilter?.(),
      active: !!filterOpen && isHome,
    },
    {
      id: 'coloring',
      icon: <Eye size={18} strokeWidth={1.7} />,
      label: 'Row coloring',
      onClick: () => onToggleColoring?.(),
      active: !!coloringOpen,
    },
    {
      id: 'import',
      icon: <Upload size={18} strokeWidth={1.7} />,
      label: 'Import',
      onClick: () => navigate('/import'),
      active: isImport,
    },
    {
      id: 'saved',
      icon: <Bookmark size={18} strokeWidth={1.7} />,
      label: 'Saved searches',
      onClick: () => navigate('/saved'),
      active: isSaved,
    },
    {
      id: 'alerts',
      icon: <Bell size={18} strokeWidth={1.7} />,
      label: 'Alerts',
      onClick: () => navigate('/alerts'),
      active: isAlerts,
    },
    {
      id: 'settings',
      icon: <Settings size={18} strokeWidth={1.7} />,
      label: 'Settings',
      onClick: () => navigate('/settings'),
      active: isSettings,
    },
  ];

  return (
    <nav
      className="flex flex-col items-center h-full"
      style={{
        width: 'var(--ls-rail-w)',
        background: 'var(--ls-panel)',
        borderRight: '1px solid var(--ls-border)',
        padding: '10px 0 8px',
        gap: 4,
        flexShrink: 0,
      }}
    >
      {primary.map((entry) => (
        <RailButton key={entry.id} entry={entry} />
      ))}
      <div style={{ flex: 1 }} />
      {onToggleTweaks && (
        <RailButton
          entry={{
            id: 'tweaks',
            icon: <Zap size={18} strokeWidth={1.7} />,
            label: 'Tweaks',
            onClick: onToggleTweaks,
          }}
        />
      )}
    </nav>
  );
};

const RailButton = ({ entry }: { entry: RailEntry }) => (
  <button
    type="button"
    onClick={entry.onClick}
    className={cn(
      'group relative grid place-items-center rounded-lg transition-colors',
      entry.active ? 'rail-btn-active' : 'rail-btn'
    )}
    aria-label={entry.label}
    title={entry.label}
    style={{
      width: 36,
      height: 36,
      color: entry.active ? 'var(--ls-accent-text)' : 'var(--ls-text-3)',
      background: entry.active ? 'var(--ls-accent-soft)' : 'transparent',
    }}
  >
    {entry.icon}
    {entry.active && (
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: -10,
          top: 7,
          bottom: 7,
          width: 2,
          background: 'var(--ls-accent)',
          borderRadius: '0 2px 2px 0',
        }}
      />
    )}
    <span
      className="rail-tooltip"
      style={{
        position: 'absolute',
        left: 'calc(100% + 10px)',
        top: '50%',
        transform: 'translateY(-50%)',
        background: 'var(--ls-text)',
        color: 'var(--ls-bg)',
        padding: '4px 8px',
        borderRadius: 5,
        fontSize: 11.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        opacity: 0,
        transition: 'opacity .1s ease',
        zIndex: 50,
      }}
    >
      {entry.label}
    </span>
  </button>
);

export default LeftRail;
