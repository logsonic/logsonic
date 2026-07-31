import { Download, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { getLogs } from '@/lib/api-client';
import { calculateRelativeDateRange } from '@/lib/date-utils';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';

// Cap exports so we don't churn the browser on huge result sets; the user
// is warned via toast if matches exceed this.
const EXPORT_MAX_ROWS = 100_000;

export const LogExportButton = () => {
  const store = useSearchQueryParamsStore();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  // Export all rows matching the current query (not just the visible page).
  // The old behavior dumped only the current page silently, which was lossy.
  const handleExport = useCallback(async () => {
    const totalCount = store.resultCount;
    if (totalCount === 0) {
      toast({
        title: 'Nothing to export',
        description: 'Run a search that returns at least one row.',
        variant: 'default',
      });
      return;
    }

    setIsExporting(true);
    try {
      // Resolve the active time range - mirrors useSearchLogs so relative
      // ranges aren't snapshotted to a stale value.
      let startDate = store.UTCTimeSince;
      let endDate = store.UTCTimeTo;
      if (store.isRelative) {
        const r = calculateRelativeDateRange(
          store.relativeValue,
          store.customRelativeUnit,
          store.customRelativeCount
        );
        startDate = r.startDate;
        endDate = r.endDate;
      }

      const cappedAt = Math.min(totalCount, EXPORT_MAX_ROWS);
      const result = await getLogs({
        query: store.searchQuery,
        _src: store.sources.join(','),
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        limit: cappedAt,
        offset: 0,
        sort_by: store.sortBy,
        sort_order: store.sortOrder,
      });

      const logs = result?.logs ?? [];
      if (logs.length === 0) {
        toast({
          title: 'Export failed',
          description: 'Backend returned no rows for this query.',
          variant: 'destructive',
        });
        return;
      }

      const jsonl = logs.map((log) => JSON.stringify(log)).join('\n') + '\n';
      const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `logsonic-export-${ts}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (totalCount > EXPORT_MAX_ROWS) {
        toast({
          title: `Exported first ${EXPORT_MAX_ROWS.toLocaleString()} of ${totalCount.toLocaleString()} rows`,
          description: 'Narrow the time range or query to export the remainder.',
          variant: 'default',
        });
      } else {
        toast({
          title: `Exported ${logs.length.toLocaleString()} rows`,
          variant: 'default',
        });
      }
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  }, [
    store.resultCount,
    store.searchQuery,
    store.sources,
    store.isRelative,
    store.relativeValue,
    store.customRelativeCount,
    store.customRelativeUnit,
    store.UTCTimeSince,
    store.UTCTimeTo,
    store.sortBy,
    store.sortOrder,
    toast,
  ]);

  return (
    <Button
      type="button"
      variant="ghost"
      className="ls-toolbar-btn h-7 rounded-md px-2.5 flex items-center gap-1"
      onClick={handleExport}
      disabled={isExporting}
      title="Export matching rows"
    >
      {isExporting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span className="text-xs">{isExporting ? 'Exporting...' : 'Export'}</span>
    </Button>
  );
};

export default LogExportButton;
