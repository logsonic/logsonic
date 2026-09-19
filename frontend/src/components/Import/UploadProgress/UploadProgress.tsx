import { Check, ChevronDown, ChevronUp, Circle, X } from 'lucide-react';
import { FC, useMemo } from 'react';

import { useImportStore } from '@/stores/useImportStore';

interface UploadProgressProps {
  onCancel: () => void;
}

/**
 * Centered card shown while useUpload streams the files. Progress is the
 * same per-file data the wizard's UploadingStep read (chunk callbacks in
 * browser mode, SSE ingest_progress in native mode), rolled into one bar
 * with the per-file rows one click away.
 */
export const UploadProgress: FC<UploadProgressProps> = ({ onCancel }) => {
  const files = useImportStore((s) => s.files);
  const expanded = useImportStore((s) => s.isExpandedPerFileDetails);
  const toggle = useImportStore((s) => s.togglePerFileDetails);

  const { pct, processed, expected } = useMemo(() => {
    const pctSum = files.reduce((s, f) => {
      if (f.uploadStatus === 'success' || f.uploadStatus === 'failed') return s + 100;
      return s + (f.uploadProgress || 0);
    }, 0);
    return {
      pct: files.length > 0 ? Math.floor(pctSum / files.length) : 0,
      processed: files.reduce((s, f) => s + (f.totalLinesProcessed || 0), 0),
      expected: files.reduce((s, f) => s + (f.approxLines || 0), 0),
    };
  }, [files]);

  return (
    <div className="ls-imp-center">
      <div className="ls-imp-modal" role="status" aria-live="polite">
        <div className="ls-imp-spinner" aria-hidden />
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ls-text)' }}>
          Importing {files.length} file{files.length === 1 ? '' : 's'}
        </div>
        <div
          className="ls-imp-mono"
          style={{ marginTop: 4, fontSize: 12.5, color: 'var(--ls-text-3)' }}
        >
          {processed.toLocaleString()} of ~{expected.toLocaleString()} lines
        </div>
        <div className="ls-imp-progress">
          <div className="ls-imp-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div
          className="ls-imp-mono"
          style={{ marginTop: 6, fontSize: 12, color: 'var(--ls-accent)' }}
        >
          {pct}%
        </div>

        <button
          type="button"
          className="ls-imp-link inline-flex items-center"
          style={{ marginTop: 18, fontSize: 12, gap: 4 }}
          onClick={toggle}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide per-file details' : 'Show per-file details'}
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>

        {expanded && (
          <div
            className="ls-rise"
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--ls-border-subtle)',
              textAlign: 'left',
            }}
          >
            {files.map((f) => {
              const icon =
                f.uploadStatus === 'success' ? (
                  <Check size={13} style={{ color: 'var(--ls-ok)' }} />
                ) : f.uploadStatus === 'failed' ? (
                  <X size={13} style={{ color: 'var(--ls-err)' }} />
                ) : f.uploadStatus === 'uploading' ? (
                  <Circle size={10} fill="currentColor" style={{ color: 'var(--ls-accent)' }} />
                ) : (
                  <Circle size={10} style={{ color: 'var(--ls-text-4)' }} />
                );
              const status =
                f.uploadStatus === 'success'
                  ? `${f.totalLinesProcessed.toLocaleString()} lines`
                  : f.uploadStatus === 'uploading'
                    ? `${f.totalLinesProcessed.toLocaleString()} / ${f.approxLines > 0 ? `~${f.approxLines.toLocaleString()}` : '…'}${
                        f.nativePath && f.ingestRateLinesPerS
                          ? ` · ${Math.round(f.ingestRateLinesPerS).toLocaleString()}/s`
                          : ''
                      }`
                    : f.uploadStatus === 'failed'
                      ? ''
                      : 'queued';
              return (
                <div key={f.id} style={{ padding: '4px 0' }}>
                  <div className="flex items-center" style={{ gap: 8 }}>
                    <span className="inline-flex" style={{ width: 14, justifyContent: 'center' }}>
                      {icon}
                    </span>
                    <span
                      className="truncate"
                      style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}
                    >
                      {f.fileName}
                    </span>
                    <span
                      className="ls-imp-mono ml-auto flex-shrink-0"
                      style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}
                    >
                      {status}
                    </span>
                  </div>
                  {!!f.rowsFailed && f.rowsFailed > 0 && (
                    <div style={{ paddingLeft: 22, fontSize: 11, color: 'var(--ls-warn)' }}>
                      {f.rowsFailed.toLocaleString()} row{f.rowsFailed === 1 ? '' : 's'} failed to
                      parse
                    </div>
                  )}
                  {f.uploadStatus === 'failed' && (
                    <div style={{ paddingLeft: 22, fontSize: 11, color: 'var(--ls-err)' }}>
                      {f.uploadError || 'Upload failed'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <button type="button" className="ls-imp-cancel-link" onClick={onCancel}>
            Cancel import
          </button>
        </div>
      </div>
    </div>
  );
};

export default UploadProgress;
