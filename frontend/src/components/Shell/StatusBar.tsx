import { useBackendStatus } from '@/hooks/useBackendStatus';
import { formatBytes } from '@/lib/utils';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

const dot = (color: string, pulse = false) => (
  <span
    className={pulse ? 'ls-pulse' : undefined}
    style={{
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: color,
      display: 'inline-block',
    }}
  />
);

const Divider = () => (
  <span
    aria-hidden
    style={{ width: 1, height: 12, background: 'var(--ls-border)', display: 'inline-block' }}
  />
);

const APP_VERSION = 'v2';

export const StatusBar = () => {
  const { isConnected } = useBackendStatus(5000);
  const { systemInfo } = useSystemInfoStore();
  const { apiExecutionTime } = useSearchQueryParamsStore();
  const { logData } = useLogResultStore();

  const sourceCount = systemInfo?.storage_info?.source_names?.length ?? 0;
  const totalEvents = systemInfo?.storage_info?.total_log_entries ?? 0;
  const storageBytes = systemInfo?.storage_info?.storage_size_bytes;

  // apiExecutionTime is in microseconds — convert to ms
  const apiMs = apiExecutionTime != null ? apiExecutionTime / 1000 : null;

  return (
    <div
      className="flex items-center"
      style={{
        height: 'var(--ls-statusbar-h)',
        padding: '0 12px',
        background: 'var(--ls-panel)',
        borderTop: '1px solid var(--ls-border)',
        fontFamily: 'var(--ls-font-sans)',
        fontSize: 11,
        color: 'var(--ls-text-3)',
        gap: 14,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      <span
        className="inline-flex items-center"
        style={{
          gap: 5,
          color: isConnected ? 'var(--ls-ok)' : 'var(--ls-err)',
          fontWeight: 500,
        }}
      >
        {dot(isConnected ? 'var(--ls-ok)' : 'var(--ls-err)', isConnected)}
        {isConnected ? `${sourceCount} source${sourceCount === 1 ? '' : 's'} indexed` : 'Backend disconnected'}
      </span>
      <Divider />
      <span>
        Events{' '}
        <b style={{ color: 'var(--ls-text-2)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
          {totalEvents.toLocaleString()}
        </b>
      </span>
      {apiMs !== null && (
        <>
          <Divider />
          <span>
            Last query{' '}
            <b style={{ color: 'var(--ls-text-2)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
              {Math.round(apiMs)}ms
            </b>
          </span>
        </>
      )}
      {logData?.total_count !== undefined && (
        <>
          <Divider />
          <span>
            Hits{' '}
            <b style={{ color: 'var(--ls-text-2)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
              {logData.total_count.toLocaleString()}
            </b>
          </span>
        </>
      )}
      {storageBytes !== undefined && (
        <>
          <Divider />
          <span>
            Storage{' '}
            <b style={{ color: 'var(--ls-text-2)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
              {formatBytes(storageBytes)}
            </b>
          </span>
        </>
      )}
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--ls-font-mono)', fontSize: 11 }}>
        {APP_VERSION}
      </span>
    </div>
  );
};

export default StatusBar;
