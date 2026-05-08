import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { BarChart3, Bell, Bookmark, Download, Share2 } from 'lucide-react';
import { useMemo } from 'react';

const Stat = ({
  label,
  value,
  color,
}: {
  label?: string;
  value: string | number;
  color?: string;
}) => (
  <span
    className="inline-flex items-center"
    style={{
      gap: 6,
      fontSize: 11.5,
      color: 'var(--ls-text-3)',
    }}
  >
    {label && <span>{label}</span>}
    <span
      style={{
        fontFamily: 'var(--ls-font-mono)',
        fontSize: 12,
        color: color ?? 'var(--ls-text)',
        fontWeight: 500,
      }}
    >
      {typeof value === 'number' ? value.toLocaleString() : value}
    </span>
  </span>
);

const Divider = () => (
  <span
    aria-hidden
    style={{ width: 1, height: 18, background: 'var(--ls-border)' }}
  />
);

const GhostBtn = ({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center transition-colors"
    style={{
      gap: 6,
      height: 24,
      padding: '0 8px',
      borderRadius: 5,
      fontSize: 12,
      fontWeight: 500,
      background: 'transparent',
      color: 'var(--ls-text-2)',
      border: '1px solid transparent',
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
  >
    {icon}
    <span>{children}</span>
  </button>
);

/**
 * Subtoolbar between histogram and table: shows hits / errors / warnings / scanned
 * with right-side actions: Visualize / Save search / Create alert / Share / Export.
 */
export const SubToolbar = () => {
  const { logData } = useLogResultStore();
  const { apiExecutionTime } = useSearchQueryParamsStore();

  const total = logData?.total_count ?? 0;

  // Heuristic level counts from current page of logs
  const { errorCount, warnCount } = useMemo(() => {
    const out = { errorCount: 0, warnCount: 0 };
    const logs = logData?.logs ?? [];
    for (const log of logs) {
      const lvl = String(log.level ?? log._level ?? log.severity ?? '').toUpperCase();
      const status = Number(log.status ?? log.status_code ?? log.code ?? NaN);
      if (lvl === 'ERROR' || lvl === 'FATAL' || (Number.isFinite(status) && status >= 500)) {
        out.errorCount += 1;
      } else if (lvl === 'WARN' || lvl === 'WARNING' || (Number.isFinite(status) && status >= 400)) {
        out.warnCount += 1;
      }
    }
    return out;
  }, [logData]);

  const scannedMs = apiExecutionTime != null ? Math.max(1, Math.round(apiExecutionTime / 1000)) : null;

  return (
    <div
      className="flex items-center"
      style={{
        gap: 10,
        padding: '8px 12px',
        background: 'var(--ls-panel)',
        borderBottom: '1px solid var(--ls-border)',
        flexShrink: 0,
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      }}
    >
      <Stat value={total} />
      <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>hits</span>
      <Divider />
      <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>errors</span>
      <Stat value={errorCount} color="var(--ls-err)" />
      <Divider />
      <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>warnings</span>
      <Stat value={warnCount} color="var(--ls-warn)" />
      {scannedMs !== null && (
        <>
          <Divider />
          <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>scanned</span>
          <Stat value={`${scannedMs}ms`} />
        </>
      )}
      <span style={{ flex: 1 }} />
      <GhostBtn icon={<BarChart3 size={13} />}>Visualize</GhostBtn>
      <GhostBtn icon={<Bookmark size={13} />}>Save search</GhostBtn>
      <GhostBtn icon={<Bell size={13} />}>Create alert</GhostBtn>
      <GhostBtn icon={<Share2 size={13} />}>Share</GhostBtn>
      <GhostBtn icon={<Download size={13} />}>Export</GhostBtn>
    </div>
  );
};

export default SubToolbar;
