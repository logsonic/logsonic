import { ApiError } from '@/lib/api-client';

/**
 * User copy for the failures the sources and storage surfaces can hit,
 * keyed on the server's error code. The server's `details` is operator
 * text (it names API routes), so it is only consulted to pick between
 * phrasings, never shown as-is. Anything unmapped falls back to the
 * server's one-line message, then to the caller's fallback.
 */
export const apiErrorMessage = (err: unknown, fallback: string): string => {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'SOURCE_IN_USE':
      case 'DAY_IN_USE':
        if (err.details?.includes('folder watch')) {
          return 'A folder watch is following this file. Pause or delete the watch first (Settings → Watched folders).';
        }
        return err.details?.includes('live tail')
          ? 'A live tail is still writing here. Stop it first.'
          : 'An import is still running here. Wait for it to finish.';
      case 'SOURCE_NOT_REIMPORTABLE':
        return 'This source was uploaded from the browser, so there is no file to re-import from.';
      case 'SOURCE_NAME_TAKEN':
        return 'Another source already uses that name.';
      case 'SOURCE_NAME_INVALID':
        return 'Use 1–120 characters with no leading or trailing spaces.';
      case 'INVALID_PATH':
        return 'The original file is no longer readable at its recorded path. Nothing was deleted.';
      case 'SOURCE_NOT_FOUND':
        return 'That source no longer exists.';
      case 'DAY_NOT_FOUND':
        return 'There are no logs stored for that day any more.';
      case 'RETENTION_OUT_OF_RANGE':
        return 'Retention must be between 0 (keep everything) and 3650 days.';
      case 'STORAGE_SETTINGS_UNAVAILABLE':
        return 'Settings could not be saved: config.json could not be opened at startup. Check the server log.';
      case 'WATCH_EXISTS':
        return 'That folder is already watched.';
      case 'WATCH_NOT_FOUND':
        return 'That watch no longer exists.';
      case 'WATCHES_UNAVAILABLE':
        return 'Folder watches are unavailable: watches.json could not be opened at startup. Check the server log.';
    }
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
};
