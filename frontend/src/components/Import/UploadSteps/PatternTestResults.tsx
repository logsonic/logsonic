import { useImportStore } from '@/stores/useImportStore';
import { TimestampInference } from '@/lib/api-types';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { FC, useMemo, useState } from 'react';
import type { PatternTestResultsProps } from '../types';
import { getFieldColors, highlightLogLine } from '../utils/patternUtils';
import StatusBanner from './StatusBanner';
import TimestampToolbar from './TimestampToolbar';

interface PatternTestResultsExtendedProps extends Omit<PatternTestResultsProps, 'parsedLogs' | 'isLoading' | 'error'> {
  // When provided, these override the global store (used for per-file cards)
  parsedLogsOverride?: Record<string, string>[];
  isLoadingOverride?: boolean;
  errorOverride?: string | null;
}

// Visual cues for the resolved-timestamp column. Sync with the
// confidenceClass map in TimestampToolbar so chip and per-row cells
// use the same palette. Token-based so dark mode works.
const confidenceColor: Record<string, string> = {
  exact:     'var(--ls-ok)',
  inferred:  'var(--ls-info)',
  carried:   'var(--ls-text-3)',
  synthetic: 'var(--ls-err)',
};

// Pull the resolved time + confidence for a row index. Confidence
// only comes from inference.preview (kept fresh by the toolbar's
// debounced /timestamp/preview calls); when a row falls outside the
// preview window we still show the raw timestamp from parsedLogs but
// without a confidence badge — those rows are scrolled-past samples
// that the user is unlikely to be inspecting in detail.
function rowTimestamp(
  inference: TimestampInference | null,
  parsed: Record<string, any> | undefined,
  globalIndex: number,
): { resolved: string; confidence: string | null } | null {
  if (inference?.preview && globalIndex < inference.preview.length) {
    const p = inference.preview[globalIndex];
    return { resolved: p.resolved, confidence: p.confidence };
  }
  if (parsed?.timestamp) {
    return {
      resolved: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date(parsed.timestamp).toISOString(),
      confidence: null,
    };
  }
  return null;
}

// Format an ISO-ish timestamp into the same compact single-line form
// the home log table uses: "2017-05-16 00:00:00.008". Strip timezone
// suffix to keep the column narrow — TZ is communicated once in the
// toolbar above, not per row.
function formatResolved(iso: string): string {
  const tIdx = iso.indexOf('T');
  if (tIdx < 0) return iso;
  const date = iso.slice(0, tIdx);
  let time = iso.slice(tIdx + 1);
  // Drop trailing TZ ("Z" or "+02:00") — it'd just add visual noise.
  time = time.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  return `${date} ${time}`;
}

export const PatternTestResults: FC<PatternTestResultsExtendedProps> = ({
  logs,
  pattern,
  customPatterns,
  parsedLogsOverride,
  isLoadingOverride,
  errorOverride,
}) => {
  const {
    parsedLogs: storeParsedLogs,
    isTestingPattern: storeIsTestingPattern,
    error: storeError,
    timestampInference: globalInference,
    getActiveFile,
    files,
    importSource,
  } = useImportStore();

  const parsedLogs = parsedLogsOverride !== undefined ? parsedLogsOverride : storeParsedLogs;
  const isTestingPattern = isLoadingOverride !== undefined ? isLoadingOverride : storeIsTestingPattern;
  const error = errorOverride !== undefined ? errorOverride : storeError;

  // Inference source mirrors TimestampToolbar's logic so the resolved
  // column and the chip in the toolbar stay in sync.
  const activeFile = getActiveFile();
  const isMultiFile = importSource === 'file' && files.length > 0 && !!activeFile;
  const inference: TimestampInference | null = isMultiFile
    ? (activeFile?.timestampInference ?? null)
    : globalInference;

  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [showErrorBanner, setShowErrorBanner] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const logsPerPage = 20;

  const successfulMatches = useMemo(() => {
    if (!parsedLogs) return 0;
    return parsedLogs.filter(log => !log.error).length;
  }, [parsedLogs]);

  const totalPages = Math.max(1, Math.ceil(logs.length / logsPerPage));
  const startIndex = currentPage * logsPerPage;
  const endIndex = Math.min(startIndex + logsPerPage, logs.length);
  const currentLogs = logs.slice(startIndex, endIndex);

  const toggleRow = (idx: number) => {
    setExpandedRows(prev => ({ ...prev, [idx + startIndex]: !prev[idx + startIndex] }));
  };

  const goToNextPage = () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
      setExpandedRows({});
    }
  };
  const goToPrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
      setExpandedRows({});
    }
  };

  if (isTestingPattern) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-primary mr-3" />
        <span className="text-base text-gray-600">Testing pattern...</span>
      </div>
    );
  }

  if (error && showErrorBanner) {
    return (
      <StatusBanner
        type="error"
        title="Error testing pattern"
        message={error}
        onClose={() => setShowErrorBanner(false)}
      />
    );
  }

  if (!parsedLogs || parsedLogs.length === 0) {
    return (
      <StatusBanner
        type="warning"
        title="No logs were successfully parsed with this pattern."
        onClose={() => {}}
      />
    );
  }

  const allFields = new Set<string>();
  parsedLogs.forEach(log => Object.keys(log).forEach(key => allFields.add(key)));
  const fieldNames = Array.from(allFields);
  const fieldColors = getFieldColors(fieldNames);

  // Column dimensions — match the home log table's compact rhythm.
  // TIMESTAMP column is sized for "2017-05-16 00:00:00.008" + a small
  // confidence dot prefix, no wasted slack.
  const gridCols = '20px 200px 1fr';

  return (
    <div className="flex flex-col">
      {/* Fused card: timestamp toolbar followed by a dense preview table
          that mirrors the main home log-table styling — same mono font,
          12px rows, sticky header strip, hover wash, accent expansion. */}
      <div
        style={{
          borderRadius: 8,
          border: '1px solid var(--ls-border)',
          background: 'var(--ls-panel)',
          overflow: 'hidden',
          boxShadow: 'var(--ls-shadow-sm)',
        }}
      >
        {/* Toolbar header */}
        <div
          style={{
            padding: '10px 12px 8px',
            borderBottom: '1px solid var(--ls-border)',
            background: 'var(--ls-bg-1)',
          }}
        >
          <TimestampToolbar />
          <div
            style={{
              fontSize: 11,
              color: 'var(--ls-text-3)',
              marginTop: 6,
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            Successfully parsed {successfulMatches} of {logs.length} log lines.
          </div>
        </div>

        {/* Column header row — uppercase, matches home log-table thead */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: gridCols,
            background: 'var(--ls-bg-2)',
            borderBottom: '1px solid var(--ls-border)',
            fontFamily: 'var(--ls-font-sans)',
            fontSize: 10.5,
            fontWeight: 600,
            color: 'var(--ls-text-2)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          <div />
          <div style={{ padding: '6px 10px', borderRight: '1px solid var(--ls-border)' }}>
            Timestamp
          </div>
          <div style={{ padding: '6px 10px' }}>Raw line</div>
        </div>

        {/* Preview rows — each row a single 12px mono line, hover wash */}
        <div>
          {currentLogs.map((log, idx) => {
            const globalIdx = idx + startIndex;
            const parsed = parsedLogs[globalIdx];
            const ts = rowTimestamp(inference, parsed, globalIdx);
            const expanded = expandedRows[globalIdx];
            const hasError = parsed?.error;
            const isLast = idx === currentLogs.length - 1;

            return (
              <div key={globalIdx}>
                <div
                  className="grid cursor-pointer transition-colors items-center"
                  style={{
                    gridTemplateColumns: gridCols,
                    borderBottom:
                      !isLast || expanded ? '1px solid var(--ls-border-subtle)' : 'none',
                    background: expanded ? 'var(--ls-accent-softer)' : 'transparent',
                  }}
                  onClick={() => toggleRow(idx)}
                  onMouseEnter={(e) => {
                    if (!expanded) e.currentTarget.style.background = 'var(--ls-bg-2)';
                  }}
                  onMouseLeave={(e) => {
                    if (!expanded) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {/* Expander */}
                  <div className="flex items-center justify-center" style={{ color: 'var(--ls-text-3)' }}>
                    {expanded
                      ? <ChevronDown size={12} />
                      : <ChevronRight size={12} />}
                  </div>

                  {/* Resolved timestamp + tiny confidence dot prefix */}
                  <div
                    style={{
                      padding: '4px 10px',
                      borderRight: '1px solid var(--ls-border-subtle)',
                      fontFamily: 'var(--ls-font-mono)',
                      fontSize: 12,
                      color: ts?.confidence ? confidenceColor[ts.confidence] : 'var(--ls-text-2)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                    title={ts?.confidence ? `${ts.confidence}: ${ts.resolved}` : ts?.resolved}
                  >
                    {ts ? (
                      <span className="inline-flex items-center" style={{ gap: 6 }}>
                        {ts.confidence && (
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: confidenceColor[ts.confidence],
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <span>{formatResolved(ts.resolved)}</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--ls-text-4)', fontStyle: 'italic' }}>
                        no timestamp
                      </span>
                    )}
                  </div>

                  {/* Raw line with grok-token highlighting */}
                  <div
                    className="overflow-hidden"
                    style={{
                      padding: '4px 10px',
                      fontFamily: 'var(--ls-font-mono)',
                      fontSize: 12,
                      color: 'var(--ls-text)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {parsed && !hasError ? (
                      <div className="truncate">{highlightLogLine(log, parsed)}</div>
                    ) : (
                      <span
                        className="truncate block"
                        style={{ color: 'var(--ls-text-3)' }}
                      >
                        {log}
                      </span>
                    )}
                  </div>
                </div>

                {/* Expanded row — full field list */}
                {expanded && parsed && (
                  <div
                    style={{
                      padding: '10px 16px 10px 36px',
                      background: 'var(--ls-bg-1)',
                      borderTop: '1px solid var(--ls-border-subtle)',
                      borderBottom: !isLast ? '1px solid var(--ls-border-subtle)' : 'none',
                    }}
                  >
                    <div className="grid grid-cols-2" style={{ gap: 6 }}>
                      {Object.entries(parsed)
                        // Hide unmatched optional fields (`-`, '', undefined)
                        // so the expanded view doesn't show a wall of
                        // empty `client_ip:` style chips.
                        .filter(([field, value]) =>
                          field !== '_raw' && field !== '_src' &&
                          value !== null && value !== undefined &&
                          String(value).trim() !== '' && String(value) !== '-'
                        )
                        .map(([field, value]) => (
                        <div key={field} className="flex items-center" style={{ minWidth: 0 }}>
                          <span
                            className="inline-flex items-center flex-shrink-0"
                            style={{
                              padding: '1px 6px',
                              marginRight: 8,
                              borderRadius: 4,
                              fontSize: 10.5,
                              fontFamily: 'var(--ls-font-mono)',
                              border: '1px solid var(--ls-border)',
                              background: fieldColors[field] ? undefined : 'var(--ls-bg-2)',
                              color: fieldColors[field] ? undefined : 'var(--ls-text-2)',
                            }}
                          >
                            <span className={fieldColors[field] || ''}>{field}</span>
                          </span>
                          <span
                            className="truncate"
                            style={{
                              fontFamily: 'var(--ls-font-mono)',
                              fontSize: 11.5,
                              color: 'var(--ls-text)',
                            }}
                          >
                            {String(value).substring(0, 120)}
                            {String(value).length > 120 ? '…' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Pagination footer */}
        <div
          className="flex justify-between items-center"
          style={{
            padding: '6px 10px',
            borderTop: '1px solid var(--ls-border)',
            background: 'var(--ls-bg-1)',
          }}
        >
          <button
            type="button"
            onClick={goToPrevPage}
            disabled={currentPage === 0}
            className="inline-flex items-center justify-center transition-colors"
            style={{
              height: 24,
              padding: '0 8px',
              borderRadius: 4,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-panel)',
              color: 'var(--ls-text-2)',
              cursor: currentPage === 0 ? 'not-allowed' : 'pointer',
              opacity: currentPage === 0 ? 0.4 : 1,
            }}
            aria-label="Previous page"
          >
            <ArrowLeft size={12} />
          </button>
          <div
            style={{
              fontSize: 11,
              color: 'var(--ls-text-3)',
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            Showing {startIndex + 1}-{endIndex} of {logs.length} logs
          </div>
          <button
            type="button"
            onClick={goToNextPage}
            disabled={currentPage >= totalPages - 1}
            className="inline-flex items-center justify-center transition-colors"
            style={{
              height: 24,
              padding: '0 8px',
              borderRadius: 4,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-panel)',
              color: 'var(--ls-text-2)',
              cursor: currentPage >= totalPages - 1 ? 'not-allowed' : 'pointer',
              opacity: currentPage >= totalPages - 1 ? 0.4 : 1,
            }}
            aria-label="Next page"
          >
            <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PatternTestResults;
