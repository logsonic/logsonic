import { useImportStore } from '@/stores/useImportStore';
import { CheckCircle, File, Loader2, XCircle } from 'lucide-react';
import { FC, useMemo } from 'react';

const statusMeta = {
  pending:   { label: 'Queued',     fg: 'var(--ls-text-3)', bg: 'var(--ls-bg-2)',    border: 'var(--ls-border)' },
  uploading: { label: 'Uploading…', fg: 'var(--ls-info)',   bg: 'var(--ls-info-soft)', border: 'color-mix(in srgb, var(--ls-info) 25%, transparent)' },
  success:   { label: 'Done',       fg: 'var(--ls-ok)',     bg: 'var(--ls-ok-soft)',   border: 'color-mix(in srgb, var(--ls-ok) 25%, transparent)' },
  failed:    { label: 'Failed',     fg: 'var(--ls-err)',    bg: 'var(--ls-err-soft)',  border: 'color-mix(in srgb, var(--ls-err) 25%, transparent)' },
} as const;

export const UploadingStep: FC = () => {
  const { files } = useImportStore();

  const { doneCount, totalCount, overallPct, linesProcessed } = useMemo(() => {
    const done = files.filter(f => f.uploadStatus === 'success' || f.uploadStatus === 'failed').length;
    const pctSum = files.reduce((s, f) => {
      if (f.uploadStatus === 'success' || f.uploadStatus === 'failed') return s + 100;
      return s + (f.uploadProgress || 0);
    }, 0);
    const overall = files.length > 0 ? Math.floor(pctSum / files.length) : 0;
    const lines = files.reduce((s, f) => s + (f.totalLinesProcessed || 0), 0);
    return { doneCount: done, totalCount: files.length, overallPct: overall, linesProcessed: lines };
  }, [files]);

  return (
    <div className="space-y-5 py-2">
      <div className="flex flex-col items-center text-center">
        <div
          className="inline-flex items-center justify-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'var(--ls-info-soft)',
            border: '1px solid color-mix(in srgb, var(--ls-info) 25%, transparent)',
            marginBottom: 12,
          }}
        >
          <Loader2 size={22} className="animate-spin" style={{ color: 'var(--ls-info)' }} />
        </div>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--ls-text)',
            letterSpacing: '-0.01em',
            marginBottom: 4,
          }}
        >
          Importing files
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          {doneCount} / {totalCount} files complete · {linesProcessed.toLocaleString()} lines processed
        </p>
      </div>

      {/* Overall progress bar */}
      <div className="max-w-2xl mx-auto">
        <div
          style={{
            width: '100%',
            height: 6,
            borderRadius: 999,
            background: 'var(--ls-bg-2)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${overallPct}%`,
              height: '100%',
              background: 'var(--ls-accent)',
              transition: 'width 200ms ease',
            }}
          />
        </div>
        <div
          className="flex justify-between"
          style={{ marginTop: 4, fontSize: 11, color: 'var(--ls-text-3)', fontFamily: 'var(--ls-font-mono)' }}
        >
          <span>Overall</span>
          <span>{overallPct}%</span>
        </div>
      </div>

      {/* Per-file progress list */}
      <div
        className="max-w-2xl mx-auto"
        style={{
          borderRadius: 8,
          border: '1px solid var(--ls-border)',
          background: 'var(--ls-panel)',
          overflow: 'hidden',
        }}
      >
        {files.map((f, i) => {
          const meta = statusMeta[f.uploadStatus];
          const pct = f.uploadStatus === 'success' ? 100
                    : f.uploadStatus === 'failed'  ? 100
                    : f.uploadProgress || 0;
          const barColor = f.uploadStatus === 'success' ? 'var(--ls-ok)'
                         : f.uploadStatus === 'failed'  ? 'var(--ls-err)'
                         : 'var(--ls-info)';
          return (
            <div
              key={f.id}
              style={{
                padding: '10px 14px',
                borderBottom: i < files.length - 1 ? '1px solid var(--ls-border-subtle)' : 'none',
              }}
            >
              <div className="flex items-center" style={{ gap: 10 }}>
                {f.uploadStatus === 'success' ? (
                  <CheckCircle size={14} style={{ color: 'var(--ls-ok)', flexShrink: 0 }} />
                ) : f.uploadStatus === 'failed' ? (
                  <XCircle size={14} style={{ color: 'var(--ls-err)', flexShrink: 0 }} />
                ) : f.uploadStatus === 'uploading' ? (
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--ls-info)', flexShrink: 0 }} />
                ) : (
                  <File size={14} style={{ color: 'var(--ls-text-3)', flexShrink: 0 }} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center" style={{ gap: 6 }}>
                    <span
                      className="truncate"
                      style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}
                    >
                      {f.fileName}
                    </span>
                  </div>
                </div>
                <span
                  className="inline-flex items-center flex-shrink-0"
                  style={{
                    padding: '1px 6px',
                    borderRadius: 4,
                    border: `1px solid ${meta.border}`,
                    background: meta.bg,
                    color: meta.fg,
                    fontSize: 10.5,
                    fontFamily: 'var(--ls-font-mono)',
                  }}
                >
                  {meta.label}
                </span>
                <span
                  className="flex-shrink-0"
                  style={{
                    fontSize: 11,
                    color: 'var(--ls-text-3)',
                    fontFamily: 'var(--ls-font-mono)',
                    minWidth: 36,
                    textAlign: 'right',
                  }}
                >
                  {pct}%
                </span>
              </div>
              <div
                style={{
                  marginTop: 6,
                  width: '100%',
                  height: 3,
                  borderRadius: 999,
                  background: 'var(--ls-bg-2)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: barColor,
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              {f.uploadStatus === 'uploading' && f.totalLinesProcessed > 0 && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 10.5,
                    color: 'var(--ls-text-3)',
                    fontFamily: 'var(--ls-font-mono)',
                  }}
                >
                  {f.totalLinesProcessed.toLocaleString()} lines ingested
                </div>
              )}
              {f.uploadStatus === 'failed' && f.uploadError && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: 'var(--ls-err)',
                  }}
                >
                  {f.uploadError}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default UploadingStep;
