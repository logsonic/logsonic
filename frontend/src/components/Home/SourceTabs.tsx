import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { Plus, X } from 'lucide-react';
import { useMemo } from 'react';

const colorForSource = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  const hues = [262, 200, 145, 30, 350, 280, 175];
  return `hsl(${hues[Math.abs(h) % hues.length]} 70% 50%)`;
};

/**
 * Source tabs row shown above the search bar — one tab per ingested source,
 * the active subset becomes the search filter.
 */
export const SourceTabs = () => {
  const { systemInfo } = useSystemInfoStore();
  const { sources, setSources } = useSearchQueryParamsStore();
  const { logData } = useLogResultStore();

  const allSources = useMemo(
    () => systemInfo?.storage_info?.source_names ?? [],
    [systemInfo]
  );

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    logData?.log_distribution?.forEach((b) => {
      if (b.source_counts) {
        Object.entries(b.source_counts).forEach(([s, c]) => {
          result.set(s, (result.get(s) ?? 0) + (c as number));
        });
      }
    });
    return result;
  }, [logData]);

  if (allSources.length === 0) return null;

  const activeSources = sources.length === 0 ? allSources : sources;

  const isActive = (name: string) => activeSources.includes(name);

  const toggleOnly = (name: string) => {
    // If clicking the only-active tab, re-select all
    if (sources.length === 1 && sources[0] === name) {
      setSources([]);
    } else {
      setSources([name]);
    }
  };

  const removeSource = (name: string) => {
    if (sources.length === 0) {
      // Means all are selected; remove this one
      setSources(allSources.filter((s) => s !== name));
    } else {
      setSources(sources.filter((s) => s !== name));
    }
  };

  return (
    <div
      className="flex items-center px-2 overflow-x-auto"
      style={{
        height: 36,
        background: 'var(--ls-panel)',
        borderBottom: '1px solid var(--ls-border)',
        gap: 2,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {allSources.map((s) => {
        const active = isActive(s);
        const count = counts.get(s) ?? 0;
        return (
          <div
            key={s}
            onClick={() => toggleOnly(s)}
            className="src-tab inline-flex items-center cursor-pointer relative"
            role="tab"
            aria-selected={active}
            style={{
              gap: 6,
              height: 28,
              padding: '0 10px',
              fontSize: 12,
              fontWeight: 500,
              color: active ? 'var(--ls-text)' : 'var(--ls-text-2)',
              background: active ? 'var(--ls-bg-1)' : 'transparent',
              borderRadius: '6px 6px 0 0',
              opacity: sources.length > 0 && !active ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              if (!active) {
                e.currentTarget.style.background = 'var(--ls-bg-2)';
                e.currentTarget.style.color = 'var(--ls-text)';
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--ls-text-2)';
              }
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: colorForSource(s),
              }}
            />
            <span
              style={{
                maxWidth: 220,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={s}
            >
              {s}
            </span>
            {count > 0 && (
              <span
                style={{
                  color: 'var(--ls-text-3)',
                  fontFamily: 'var(--ls-font-mono)',
                  fontSize: 11,
                }}
              >
                {count > 999 ? `${(count / 1000).toFixed(1)}k` : count}
              </span>
            )}
            {sources.length > 0 && active && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSource(s);
                }}
                aria-label={`Remove ${s}`}
                className="grid place-items-center rounded"
                style={{
                  width: 14,
                  height: 14,
                  marginLeft: 4,
                  color: 'var(--ls-text-4)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--ls-bg-3)';
                  e.currentTarget.style.color = 'var(--ls-text)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--ls-text-4)';
                }}
              >
                <X size={11} />
              </button>
            )}
            {active && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: -1,
                  height: 2,
                  background: 'var(--ls-accent)',
                }}
              />
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => window.location.hash = '#/import'}
        className="inline-flex items-center"
        title="Import a new source"
        style={{
          gap: 6,
          height: 28,
          padding: '0 10px',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--ls-text-3)',
          borderRadius: '6px 6px 0 0',
          marginLeft: 4,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--ls-bg-2)';
          e.currentTarget.style.color = 'var(--ls-text)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--ls-text-3)';
        }}
      >
        <Plus size={13} />
        <span>Add source</span>
      </button>

      <div
        className="ml-auto inline-flex items-center"
        style={{
          gap: 6,
          color: 'var(--ls-text-3)',
          fontSize: 11.5,
          paddingRight: 8,
          flexShrink: 0,
        }}
      >
        {logData?.total_count !== undefined && (
          <>
            <span>
              Indexed{' '}
              <b
                style={{
                  color: 'var(--ls-text)',
                  fontWeight: 500,
                  fontFamily: 'var(--ls-font-mono)',
                }}
              >
                {logData.total_count.toLocaleString()}
              </b>{' '}
              events
            </span>
          </>
        )}
      </div>
    </div>
  );
};

export default SourceTabs;
