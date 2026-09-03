import { useCallback, useMemo, useRef, useState } from 'react';

import type { QueryHistoryEntry } from '@/stores/useQueryHistoryStore';

import { useQueryHistoryStore } from '@/stores/useQueryHistoryStore';

/**
 * Shell-style ↑/↓ history recall for the search input (spec now-03's
 * keyboard model): with the input empty or unchanged from a recalled entry,
 * ↑/↓ walks history; once the user edits, ↑/↓ returns to normal cursor
 * movement; Esc restores what they were typing before the recall started.
 *
 * Pure state-machine logic, no DOM assumptions beyond the KeyboardEvent
 * shape, so it's testable without rendering the input it's attached to.
 */
export function useQueryHistoryRecall(
  value: string,
  setValue: (value: string) => void,
  onRecallContext?: (entry: QueryHistoryEntry) => void,
  // Fired once when a recall session starts / ends (Esc, or walking ↓ past
  // the newest entry) so the caller can snapshot and restore whatever
  // non-text context onRecallContext applied (time range, sources) --
  // committing via Enter is not a "session end", it calls reset() instead.
  onSessionStart?: () => void,
  onSessionEnd?: () => void
) {
  // null = not currently recalling. 0 = most recent entry, 1 = the one
  // before that, etc. -- an index into useQueryHistoryStore's entries.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // What the user had typed before the recall session started, so Esc (or
  // walking ↓ past the newest entry) can put it back.
  const preRecallText = useRef('');

  // The recall session is only "live" while the input still shows exactly
  // what the last recall step put there -- any edit silently ends it, per
  // the keyboard model (F5). Read fresh each call; this hook doesn't need
  // its own re-render when history changes, only when a key is pressed.
  const isRecalling = useCallback(
    (index: number | null): boolean => {
      if (index === null) return false;
      const entries = useQueryHistoryStore.getState().entries;
      return value === (entries[index]?.query ?? '');
    },
    [value]
  );

  const recallAt = useCallback(
    (index: number) => {
      const entries = useQueryHistoryStore.getState().entries;
      const entry = entries[index];
      if (!entry) return false;
      setHistoryIndex(index);
      setValue(entry.query);
      onRecallContext?.(entry);
      return true;
    },
    [setValue, onRecallContext]
  );

  const reset = useCallback(() => {
    setHistoryIndex(null);
  }, []);

  const onKeyDown = useCallback(
    (e: { key: string; preventDefault: () => void }) => {
      const live = isRecalling(historyIndex);
      const currentIndex = live ? historyIndex : null;
      // F5: the input has diverged from the entry this session recalled --
      // commit to exiting recall now rather than leaving a stale index that
      // would only matter if the user happened to retype it back verbatim.
      if (historyIndex !== null && !live) setHistoryIndex(null);

      if (e.key === 'ArrowUp') {
        if (currentIndex === null) {
          // F3: only an empty input starts a fresh recall session -- a
          // non-empty, non-recalling input keeps normal cursor movement.
          if (value !== '') return;
          preRecallText.current = value;
          onSessionStart?.();
          if (recallAt(0)) e.preventDefault();
          return;
        }
        // F4: walk further back.
        if (recallAt(currentIndex + 1)) e.preventDefault();
        return;
      }

      if (e.key === 'ArrowDown') {
        if (currentIndex === null) return;
        if (currentIndex === 0) {
          // Walking forward past the newest entry restores the original text.
          setValue(preRecallText.current);
          setHistoryIndex(null);
          onSessionEnd?.();
          e.preventDefault();
          return;
        }
        if (recallAt(currentIndex - 1)) e.preventDefault();
        return;
      }

      if (e.key === 'Escape' && currentIndex !== null) {
        // F6: Esc during an active recall restores the original typed text
        // instead of the input's normal blur-on-Escape behavior.
        setValue(preRecallText.current);
        setHistoryIndex(null);
        onSessionEnd?.();
        e.preventDefault();
      }
    },
    [historyIndex, isRecalling, recallAt, setValue, value, onSessionStart, onSessionEnd]
  );

  return useMemo(() => ({ onKeyDown, reset }), [onKeyDown, reset]);
}
