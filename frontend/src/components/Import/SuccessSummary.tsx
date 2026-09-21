import { Check, X } from 'lucide-react';
import { FC, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatSize } from './utils/importGate';

import { getSystemInfo } from '@/lib/api-client';
import { useImportStore } from '@/stores/useImportStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

const REDIRECT_SECONDS = 5;

/**
 * Completion card. Refreshes /info (so home and the status bar see the new
 * sources) and, when every file succeeded, counts down to home. A partial
 * failure stays put -- the user has to read the per-file errors and leave
 * via the button.
 */
export const SuccessSummary: FC = () => {
  const files = useImportStore((s) => s.files);
  const reset = useImportStore((s) => s.reset);
  const navigate = useNavigate();
  const setSystemInfo = useSystemInfoStore((s) => s.setSystemInfo);
  const resetSearchParams = useSearchQueryParamsStore((s) => s.resetStore);

  const succeeded = useMemo(() => files.filter((f) => f.uploadStatus === 'success'), [files]);
  const failed = useMemo(() => files.filter((f) => f.uploadStatus === 'failed'), [files]);
  const lines = succeeded.reduce((s, f) => s + f.totalLinesProcessed, 0);
  const bytes = succeeded.reduce((s, f) => s + f.fileSize, 0);
  const allOk = failed.length === 0;

  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);

  const goHome = () => {
    reset();
    navigate('/');
  };

  useEffect(() => {
    getSystemInfo(true)
      .then(setSystemInfo)
      .catch(() => {
        // The status bar re-polls; a failed refresh here is not worth a toast.
      });
    resetSearchParams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick down, then leave from an effect -- navigating inside the state
  // updater made React warn about updating <Import> during this render.
  useEffect(() => {
    if (!allOk) return;
    const timer = window.setInterval(() => setRemaining((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [allOk]);
  useEffect(() => {
    if (!allOk || remaining > 0) return;
    reset();
    navigate('/');
  }, [allOk, remaining, navigate, reset]);

  return (
    <div className="ls-imp-center">
      <div className="ls-imp-modal" role="status">
        <div className={`ls-imp-check${allOk ? '' : ' ls-imp-check--warn'}`}>
          {allOk ? (
            <Check size={22} strokeWidth={2.5} />
          ) : (
            <span className="relative inline-flex">
              <Check size={22} strokeWidth={2.5} style={{ color: 'var(--ls-ok)' }} />
              <X
                size={12}
                strokeWidth={3}
                style={{ position: 'absolute', right: -6, bottom: -2, color: 'var(--ls-err)' }}
              />
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: allOk ? 'var(--ls-ok)' : 'var(--ls-warn)',
          }}
        >
          {allOk ? 'Import complete' : 'Import finished with errors'}
        </div>
        <div
          className="ls-imp-mono"
          style={{ marginTop: 4, fontSize: 13, color: allOk ? 'var(--ls-ok)' : 'var(--ls-text-2)' }}
        >
          {allOk
            ? `${files.length} file${files.length === 1 ? '' : 's'} · ${lines.toLocaleString()} lines${bytes > 0 ? ` · ${formatSize(bytes)}` : ''}`
            : `${succeeded.length} succeeded · ${failed.length} failed · ${lines.toLocaleString()} lines`}
        </div>

        {!allOk && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid color-mix(in srgb, var(--ls-warn) 30%, transparent)',
              textAlign: 'left',
            }}
          >
            {failed.map((f) => (
              <div key={f.id} style={{ padding: '3px 0', fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: 'var(--ls-text)' }}>{f.fileName}</span>
                <span style={{ color: 'var(--ls-err)' }}>
                  {' '}
                  — {f.uploadError || 'Upload failed'}
                </span>
              </div>
            ))}
          </div>
        )}

        {allOk && (
          <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--ls-text-2)' }}>
            Redirecting to home in {remaining}s…
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <button type="button" className="ls-imp-ok-btn" onClick={goHome}>
            View in LogSonic →
          </button>
        </div>
      </div>
    </div>
  );
};

export default SuccessSummary;
