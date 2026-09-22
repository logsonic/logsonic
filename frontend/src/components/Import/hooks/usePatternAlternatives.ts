import { useEffect, useMemo, useState } from 'react';

import { multilineConfigOf } from '../utils/multilinePresets';

import { matchRateOf } from './useFileDetection';

import type { ImportFile } from '../types';
import type { GrokPatternRequest } from '@/lib/api-types';

import { parseLogs } from '@/lib/api-client';
import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';

// How many preview lines each candidate is tested against, and how many
// POST /parse calls run at once. Every saved pattern is scored (there are
// ~90 built in), each against a 20-line sample, so the whole pass is a
// second or two against the local server and happens once per file.
const SAMPLE_LINES = 20;
const SCORE_CONCURRENCY = 8;

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface Alternative {
  pattern: GrokPatternRequest;
  match: number; // 0-100
}

/**
 * Scores the saved patterns against one file's preview so the Pattern tab
 * can list real alternatives with a match %. The suggester only returns
 * the best fit (its multi mode returns *complementary* patterns, not
 * alternatives), so the scores come from testing each saved pattern once.
 * Results are cached on the file (`patternMatches`) until its pattern
 * verdict changes.
 */
export function usePatternAlternatives(file: ImportFile | null): {
  alternatives: Alternative[];
  scoring: boolean;
} {
  const availablePatterns = useImportStore((s) => s.availablePatterns);
  const [scoring, setScoring] = useState(false);

  const candidates = useMemo(
    () => availablePatterns.filter((p) => p.name !== DEFAULT_PATTERN.name),
    [availablePatterns]
  );

  const fileId = file?.id ?? null;
  const hasMatches = !!file?.patternMatches;
  const hasPreview = (file?.previewLines.length ?? 0) > 0;

  useEffect(() => {
    if (!fileId || hasMatches || !hasPreview || candidates.length === 0) return;
    let cancelled = false;
    const store = useImportStore.getState();
    const current = store.files.find((f) => f.id === fileId);
    if (!current) return;
    const lines = current.previewLines.slice(0, SAMPLE_LINES);
    const multiline = multilineConfigOf(current.sessionOptions.multiline);
    setScoring(true);
    mapLimited(candidates, SCORE_CONCURRENCY, async (p) => {
      try {
        const res = await parseLogs({
          logs: lines,
          grok_pattern: p.pattern,
          custom_patterns: p.custom_patterns || {},
          session_options: { multiline },
        });
        return [p.name, matchRateOf(res.logs || [], lines)] as const;
      } catch {
        return [p.name, 0] as const;
      }
    }).then((entries) => {
      if (cancelled) return;
      setScoring(false);
      const after = useImportStore.getState();
      if (!after.files.some((f) => f.id === fileId)) return;
      after.updateFile(fileId, { patternMatches: Object.fromEntries(entries) });
    });
    return () => {
      cancelled = true;
      setScoring(false);
    };
  }, [fileId, hasMatches, hasPreview, candidates]);

  const alternatives = useMemo(() => {
    if (!file) return [];
    const selectedName = file.selectedPattern?.name;
    const matches = file.patternMatches;
    // Only patterns that match at least one sample line are alternatives;
    // the rest are reachable through "More patterns".
    return candidates
      .filter((p) => p.name !== selectedName)
      .map((p) => ({ pattern: p, match: matches?.[p.name] ?? 0 }))
      .filter((a) => !matches || a.match > 0)
      .sort((a, b) => b.match - a.match);
  }, [file, candidates]);

  return { alternatives, scoring };
}

export default usePatternAlternatives;
