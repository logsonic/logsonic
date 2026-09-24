import { calculateRelativeDateRange } from '@/lib/date-utils';

import type { WorkspaceTime } from '@/lib/api-types';
import type { SearchQueryParamsStoreState } from '@/stores/useSearchQueryParams';

// Keep saved column widths within the backend workspace schema's bounds.
export const MAX_WORKSPACE_COLUMN_WIDTH = 2000;

export const normalizeWorkspaceColumnWidths = (
  widths?: Record<string, unknown> | null,
): Record<string, number> => {
  const normalized: Record<string, number> = {};

  for (const [column, width] of Object.entries(widths ?? {})) {
    const numericWidth = typeof width === 'number' ? width : Number(width);
    if (!Number.isFinite(numericWidth)) continue;

    normalized[column] = Math.min(
      MAX_WORKSPACE_COLUMN_WIDTH,
      Math.max(0, Math.round(numericWidth)),
    );
  }

  return normalized;
};

// Captures the search store's current time range in the WorkspaceTime shape
// shared by a Workspace and a SavedQuery (spec now-03) -- used whenever
// "the current view" needs to be snapshotted: saving/updating a workspace,
// starring a query, or pushing a query-history entry.
export const searchStateToWorkspaceTime = (
  search: Pick<
    SearchQueryParamsStoreState,
    'isRelative' | 'relativeValue' | 'customRelativeCount' | 'customRelativeUnit' | 'UTCTimeSince' | 'UTCTimeTo'
  >,
): WorkspaceTime =>
  search.isRelative
    ? search.relativeValue === 'custom'
      ? {
          mode: 'relative',
          relative: search.relativeValue,
          custom_relative_count: search.customRelativeCount,
          custom_relative_unit: search.customRelativeUnit,
        }
      : {
          mode: 'relative',
          relative: search.relativeValue,
        }
    : {
        mode: 'absolute',
        start: search.UTCTimeSince.toISOString(),
        end: search.UTCTimeTo.toISOString(),
      };

export interface AppliedWorkspaceTime {
  isRelative: boolean;
  relativeValue: string;
  customRelativeUnit: string;
  customRelativeCount: number;
  UTCTimeSince: Date;
  UTCTimeTo: Date;
  UTCTimeSinceMs: number;
  UTCTimeToMs: number;
}

// Resolves a WorkspaceTime (from a Workspace or a SavedQuery) into concrete
// search-store fields, re-computing a relative range against *now* rather
// than pinning a stale absolute window (manual validation #1: recalling a
// "last 15 min" query the next day should re-resolve, not replay yesterday's
// resolved range). `fallback` supplies the current values to fall back to
// for a field WorkspaceTime doesn't carry (e.g. a preset relative value has
// no custom_relative_unit/count) -- normally just the search store's own
// current values.
export const applyWorkspaceTimeToSearchState = (
  time: WorkspaceTime | undefined,
  fallback: Pick<SearchQueryParamsStoreState, 'relativeValue' | 'customRelativeUnit' | 'customRelativeCount'>,
): AppliedWorkspaceTime => {
  const isRelative = time?.mode !== 'absolute';
  if (isRelative) {
    const relativeValue = time?.relative || fallback.relativeValue;
    const customRelativeUnit = time?.custom_relative_unit || fallback.customRelativeUnit;
    const customRelativeCount = time?.custom_relative_count || fallback.customRelativeCount;
    const { startDate, endDate } = calculateRelativeDateRange(
      relativeValue,
      customRelativeUnit,
      customRelativeCount,
    );
    return {
      isRelative: true,
      relativeValue,
      customRelativeUnit,
      customRelativeCount,
      UTCTimeSince: startDate,
      UTCTimeTo: endDate,
      UTCTimeSinceMs: startDate.getTime(),
      UTCTimeToMs: endDate.getTime(),
    };
  }

  const start = time?.start ? new Date(time.start) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = time?.end ? new Date(time.end) : new Date();
  const safeStart = Number.isNaN(start.getTime())
    ? new Date(Date.now() - 24 * 60 * 60 * 1000)
    : start;
  const safeEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  return {
    isRelative: false,
    relativeValue: fallback.relativeValue,
    customRelativeUnit: fallback.customRelativeUnit,
    customRelativeCount: fallback.customRelativeCount,
    UTCTimeSince: safeStart,
    UTCTimeTo: safeEnd,
    UTCTimeSinceMs: safeStart.getTime(),
    UTCTimeToMs: safeEnd.getTime(),
  };
};
