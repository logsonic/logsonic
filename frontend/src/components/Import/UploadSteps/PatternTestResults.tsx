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
// use the same palette.
const confidenceClass: Record<string, string> = {
  exact:     'text-emerald-700',
  inferred:  'text-sky-700',
  carried:   'text-slate-500',
  synthetic: 'text-rose-700',
};

const confidenceBadge: Record<string, string> = {
  exact:     'bg-emerald-50 text-emerald-700 border-emerald-200',
  inferred:  'bg-sky-50 text-sky-700 border-sky-200',
  carried:   'bg-slate-50 text-slate-600 border-slate-200',
  synthetic: 'bg-rose-50 text-rose-700 border-rose-200',
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

// Format an ISO-ish timestamp for the leading column. Keeps date and
// time stacked on two lines so the column stays narrow and the date
// remains scan-able when the file spans multiple days.
function formatResolved(iso: string): { date: string; time: string } {
  // The backend formats using "2006-01-02T15:04:05.000Z07:00".
  // Split on "T" — if missing, return as-is.
  const tIdx = iso.indexOf('T');
  if (tIdx < 0) return { date: iso, time: '' };
  const date = iso.slice(0, tIdx);
  // Drop the seconds-fraction trailing zeros for visual cleanliness:
  // 2017-06-09T20:10:40.000Z → 20:10:40Z
  let time = iso.slice(tIdx + 1);
  time = time.replace(/\.000(?=Z|[+-])/, '');
  return { date, time };
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

  return (
    <div className="flex flex-col">
      {/* Fused card: timestamp toolbar (chip + warnings + knobs +
          confirm) followed by a unified preview table where each row
          shows the resolved timestamp alongside the highlighted raw
          line. Replaces the previous separate "Pattern test
          successful!" banner + "Log Preview" + standalone
          TimestampPanel arrangement. */}
      <div className="border rounded-md overflow-hidden shadow-sm bg-white">
        {/* Toolbar header */}
        <div className="px-3 pt-3 pb-2 border-b bg-gray-50/50">
          <TimestampToolbar />
          <div className="text-xs text-muted-foreground mt-2 px-1">
            Successfully parsed {successfulMatches} of {logs.length} log lines.
          </div>
        </div>

        {/* Preview rows */}
        <div className="divide-y">
          {currentLogs.map((log, idx) => {
            const globalIdx = idx + startIndex;
            const parsed = parsedLogs[globalIdx];
            const ts = rowTimestamp(inference, parsed, globalIdx);
            const expanded = expandedRows[globalIdx];
            const hasError = parsed?.error;

            return (
              <div key={globalIdx} className="bg-white">
                <div
                  className="grid grid-cols-[24px_180px_1fr] hover:bg-gray-50 cursor-pointer transition-colors items-start"
                  onClick={() => toggleRow(idx)}
                >
                  <div className="flex items-center justify-center pt-3">
                    {expanded
                      ? <ChevronDown className="h-4 w-4 text-gray-500" />
                      : <ChevronRight className="h-4 w-4 text-gray-500" />}
                  </div>

                  {/* Resolved timestamp + confidence pill */}
                  <div className="px-2 py-2 border-r border-gray-100">
                    {ts ? (
                      <div className="flex flex-col gap-0.5">
                        <span className={`font-mono text-xs ${ts.confidence ? confidenceClass[ts.confidence] : 'text-gray-700'}`}>
                          {formatResolved(ts.resolved).date}
                        </span>
                        <span className={`font-mono text-xs ${ts.confidence ? confidenceClass[ts.confidence] : 'text-gray-700'}`}>
                          {formatResolved(ts.resolved).time}
                        </span>
                        {ts.confidence && (
                          <span className={`mt-0.5 inline-flex w-fit text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${confidenceBadge[ts.confidence] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                            {ts.confidence}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400 italic">no timestamp</span>
                    )}
                  </div>

                  {/* Raw line with grok-token highlighting */}
                  <div className="px-3 py-3 font-mono text-sm overflow-hidden">
                    {parsed && !hasError ? (
                      <div className="truncate">{highlightLogLine(log, parsed)}</div>
                    ) : (
                      <span className="text-gray-400 truncate block">{log}</span>
                    )}
                  </div>
                </div>

                {/* Expanded row content — full field list */}
                {expanded && parsed && (
                  <div className="px-4 pl-12 py-4 bg-gray-50 border-t">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {Object.entries(parsed).map(([field, value]) => (
                        <div key={field} className="flex">
                          <span className={`px-2 py-0.5 rounded mr-2 text-xs ${fieldColors[field] || 'bg-gray-100 text-gray-700'}`}>
                            {field}
                          </span>
                          <span className="py-0.5 text-gray-700 truncate font-mono text-xs">
                            {String(value).substring(0, 120)}
                            {String(value).length > 120 ? '...' : ''}
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

        {/* Pagination */}
        <div className="flex justify-between items-center p-2 border-t bg-gray-50">
          <button
            onClick={goToPrevPage}
            disabled={currentPage === 0}
            className={`flex items-center px-3 py-1 rounded border text-sm ${
              currentPage === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'
            }`}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
          </button>
          <div className="text-sm text-gray-600">
            Showing {startIndex + 1}-{endIndex} of {logs.length} logs
          </div>
          <button
            onClick={goToNextPage}
            disabled={currentPage >= totalPages - 1}
            className={`flex items-center px-3 py-1 rounded border text-sm ${
              currentPage >= totalPages - 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'
            }`}
          >
            <ArrowRight className="h-4 w-4 ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PatternTestResults;
