import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { useCallback } from 'react';

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
      // available_dates is YYYY-MM-DD strings, sorted ascending in the API
      const sorted = [...dates].sort();
      start = new Date(sorted[0] + 'T00:00:00Z');
      end = new Date(sorted[sorted.length - 1] + 'T23:59:59Z');
      // Pad one day on either side to be safe with timezone edges.
      start = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    } else {
      end = new Date();
      start = new Date(end.getTime() - 50 * 365 * 24 * 60 * 60 * 1000);
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
