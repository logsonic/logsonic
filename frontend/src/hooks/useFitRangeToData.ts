import { useCallback, useMemo } from 'react';

import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns a function that snaps the current search range to the actual span of
 * indexed log data, derived from `system_info.available_dates`. Pads the range
 * by one day on each side so logs near boundaries aren't accidentally excluded.
 *
 * Falls back to a 50-year window if system info is unavailable.
 */
export const useFitRangeToData = () => {
  const store = useSearchQueryParamsStore();
  const { systemInfo } = useSystemInfoStore();

  return useCallback(() => {
    const dates = systemInfo?.storage_info?.available_dates;
    let start: Date;
    let end: Date;

    if (dates && dates.length > 0) {
      // available_dates is YYYY-MM-DD strings, not guaranteed to be sorted
      const sorted = [...dates].sort();
      start = new Date(sorted[0] + 'T00:00:00Z');
      end = new Date(sorted[sorted.length - 1] + 'T23:59:59Z');
      // Pad one day on either side to be safe with timezone edges.
      start = new Date(start.getTime() - DAY_MS);
      end = new Date(end.getTime() + DAY_MS);
    } else {
      end = new Date();
      start = new Date(end.getTime() - 50 * 365 * DAY_MS);
    }

    store.setIsRelative(false);
    store.setUTCTimeSince(start);
    store.setUTCTimeSinceMs(start.getTime());
    store.setUTCTimeTo(end);
    store.setUTCTimeToMs(end.getTime());
    store.resetPagination();
    store.triggerSearch();
  }, [store, systemInfo]);
};

/**
 * True only when indexed log data exists entirely outside the currently
 * selected time range — i.e. widening the range would actually surface rows.
 *
 * Deliberately per-day: if any indexed day overlaps the current window, a
 * zero-result search is a query/filter problem, not a time-range problem, so
 * this stays false (there's nothing widening the range would fix).
 */
export const useHasDataOutsideRange = () => {
  const { UTCTimeSinceMs, UTCTimeToMs } = useSearchQueryParamsStore();
  const { systemInfo } = useSystemInfoStore();
  const dates = systemInfo?.storage_info?.available_dates;

  return useMemo(() => {
    if (!dates || dates.length === 0) return false;

    let hasDateInRange = false;
    let hasDateOutsideRange = false;

    for (const date of dates) {
      const dayStart = new Date(date + 'T00:00:00Z').getTime();
      const dayEnd = new Date(date + 'T23:59:59.999Z').getTime();
      const overlapsRange = dayEnd >= UTCTimeSinceMs && dayStart <= UTCTimeToMs;

      if (overlapsRange) {
        hasDateInRange = true;
      } else {
        hasDateOutsideRange = true;
      }
    }

    return !hasDateInRange && hasDateOutsideRange;
  }, [dates, UTCTimeSinceMs, UTCTimeToMs]);
};
