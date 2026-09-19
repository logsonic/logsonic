import { useCallback, useEffect, useRef } from 'react';

import { readFilePreview } from '../LocalFileImport/FileSelectionService';
import { extractFields } from '../utils/patternUtils';

import type { ImportFile, Pattern } from '../types';
import type { GrokPatternRequest, MultilineConfig, TimestampInference } from '@/lib/api-types';

import { parseLogs, previewFile, suggestPatterns } from '@/lib/api-client';
import { DEFAULT_PATTERN, sessionMultilineOption, useImportStore } from '@/stores/useImportStore';

// How many files are detected at once. Detection is one preview read plus
// two small POSTs per file; three in flight keeps a 20-file drop snappy
// without hammering the local server.
const DETECT_CONCURRENCY = 3;
// Debounce for re-detecting every file after the multiline setting changes.
const MULTILINE_REDETECT_MS = 400;

export const NO_PATTERN_DETECTED = 'No pattern auto-detected. Please select a pattern manually.';

// The file mtime the resolver anchors year-less timestamps against.
function sourceMtimeOf(file: ImportFile): string | undefined {
  return (
    file.sourceMTime ??
    (file.file?.lastModified ? new Date(file.file.lastModified).toISOString() : undefined)
  );
}

// Everything detection needs that is not on the file itself.
export interface DetectContext {
  availablePatterns: GrokPatternRequest[];
  multiline: MultilineConfig | undefined;
}

export interface DetectOutcome {
  updates: Partial<ImportFile>;
  inference: TimestampInference | null;
  // Multiline config the suggester found on this file, if any. The hook
  // applies it globally (same as the wizard did) and re-detects the rest.
  detectedMultiline: MultilineConfig | null;
}

// Native-path files (spec now-08) have no browser File to read a preview
// from -- fetch the first N lines from the server instead. Browser files
// keep the local 1 MB read, whose line-count extrapolation is now used as
// the file's approxLines (the wizard only kept previewLines.length, so
// every browser file read "~100 lines").
async function readPreview(
  file: ImportFile
): Promise<{ previewLines: string[]; approxLines: number } | null> {
  if (file.previewLines.length > 0) {
    return { previewLines: file.previewLines, approxLines: file.approxLines };
  }
  if (file.nativePath) {
    const preview = await previewFile({ path: file.nativePath });
    return { previewLines: preview.lines, approxLines: preview.approx_lines };
  }
  if (file.file) {
    const { lines, approxLines } = await readFilePreview(file.file);
    return { previewLines: lines, approxLines };
  }
  return null;
}

// Detect a pattern for one file. Ported from the wizard's
// FileAnalyzingStep so the API calls, fallbacks and error copy are the
// same; only the caller changed.
export async function detectPatternForFile(
  file: ImportFile,
  ctx: DetectContext
): Promise<DetectOutcome> {
  const sourceMtimeIso = sourceMtimeOf(file);
  try {
    const preview = await readPreview(file);
    if (!preview) {
      // Every ImportFile has exactly one of file / nativePath set (see the
      // type's own doc comment); defense against that invariant breaking.
      return {
        updates: {
          detectionStatus: 'failed',
          detectionError:
            'This file has neither browser content nor a native path to read a preview from',
          selectedPattern: DEFAULT_PATTERN,
          isCustomPattern: true,
        },
        inference: null,
        detectedMultiline: null,
      };
    }
    const { previewLines, approxLines } = preview;

    // Auto-suggest patterns against folded records when multiline is on.
    const suggestResponse = await suggestPatterns({
      logs: previewLines,
      session_options: { multiline: ctx.multiline },
    });

    if (suggestResponse.results && suggestResponse.results.length > 0) {
      const bestMatch = suggestResponse.results[0];
      const detectedMultiline = suggestResponse.multiline?.enabled
        ? suggestResponse.multiline
        : null;

      // Test the best match. Pass source_mtime so the resolver anchors
      // year-less / 2-digit-year timestamps against the file rather than
      // falling back to wall-clock now.
      const parseResponse = await parseLogs({
        logs: previewLines,
        grok_pattern: bestMatch.pattern,
        custom_patterns: bestMatch.custom_patterns || {},
        session_options: {
          source_mtime: sourceMtimeIso,
          multiline: detectedMultiline ?? ctx.multiline,
        },
      });

      if (parseResponse.logs && parseResponse.logs.length > 0) {
        // Match a saved pattern if possible so the row shows its name. The
        // catch-all "Custom Pattern" placeholder is never a match: a
        // suggested %{GREEDYDATA:message} must not be labelled custom.
        const matchingPattern = ctx.availablePatterns.find(
          (p) => p.pattern === bestMatch.pattern && p.name !== DEFAULT_PATTERN.name
        );
        const detectedPattern: Pattern = matchingPattern
          ? {
              ...matchingPattern,
              fields: extractFields(matchingPattern.pattern),
              custom_patterns: matchingPattern.custom_patterns || {},
            }
          : {
              name: bestMatch.pattern_name || 'Auto-detected',
              pattern: bestMatch.pattern,
              description: bestMatch.pattern_description || 'Automatically detected pattern',
              custom_patterns: bestMatch.custom_patterns,
              fields: extractFields(bestMatch.pattern),
            };

        return {
          updates: {
            previewLines,
            approxLines,
            detectedPattern,
            selectedPattern: detectedPattern,
            isCustomPattern: false,
            parsedLogs: parseResponse.logs,
            detectionStatus: 'detected',
            detectionError: null,
            patternMatches: undefined,
          },
          inference: parseResponse.timestamp_inference || null,
          detectedMultiline,
        };
      }
    }

    return {
      updates: {
        previewLines,
        approxLines,
        selectedPattern: DEFAULT_PATTERN,
        isCustomPattern: true,
        detectionStatus: 'failed',
        detectionError: NO_PATTERN_DETECTED,
      },
      inference: null,
      detectedMultiline: null,
    };
  } catch (err) {
    return {
      updates: {
        detectionStatus: 'failed',
        detectionError: err instanceof Error ? err.message : 'Detection failed',
        selectedPattern: DEFAULT_PATTERN,
        isCustomPattern: true,
      },
      inference: null,
      detectedMultiline: null,
    };
  }
}

// Re-parse a file's preview with an explicitly chosen pattern. Returns the
// per-file updates plus the fresh timestamp inference (the pattern decides
// which capture is the timestamp, so the inference has to move with it).
export async function parseFileWithPattern(
  file: ImportFile,
  pattern: Pattern,
  multiline: MultilineConfig | undefined
): Promise<{ updates: Partial<ImportFile>; inference: TimestampInference | null }> {
  const isCustom = pattern.name === DEFAULT_PATTERN.name;
  try {
    const parseResponse = await parseLogs({
      logs: file.previewLines,
      grok_pattern: pattern.pattern,
      custom_patterns: pattern.custom_patterns || {},
      session_options: { source_mtime: sourceMtimeOf(file), multiline },
    });
    return {
      updates: {
        selectedPattern: pattern,
        isCustomPattern: isCustom,
        parsedLogs: parseResponse.logs || [],
        detectionStatus: 'detected',
        detectionError: null,
      },
      inference: parseResponse.timestamp_inference || null,
    };
  } catch (err) {
    return {
      updates: {
        selectedPattern: pattern,
        isCustomPattern: isCustom,
        detectionStatus: 'failed',
        detectionError: err instanceof Error ? err.message : 'Failed to test pattern',
      },
      inference: null,
    };
  }
}

// Match rate (0-100) from a parse result: lines without an `error` key.
export function matchRateOf(parsedLogs: Record<string, unknown>[], previewLines: string[]): number {
  const total = parsedLogs.length || previewLines.length;
  if (total === 0) return 0;
  const ok = parsedLogs.filter((l) => !l.error).length;
  return Math.round((ok / total) * 100);
}

/**
 * Runs pattern detection for every file that enters the list, in
 * parallel (capped), the moment it is added -- there is no step to wait
 * for any more. Also owns the two follow-ups the wizard had: applying a
 * suggester-detected multiline config globally, and re-detecting every
 * file when the user changes the multiline setting.
 */
export function useFileDetection() {
  const inFlight = useRef<Set<string>>(new Set());
  const queue = useRef<string[]>([]);
  // The multiline key detection itself last applied, so the "user changed
  // multiline" effect can tell an auto-apply from a user edit and not
  // re-fire against a batch that is still running.
  const autoAppliedMultilineKey = useRef<string | null>(null);

  const files = useImportStore((s) => s.files);
  const multilineEnabled = useImportStore((s) => s.sessionOptionsMultilineEnabled);
  const multilineMode = useImportStore((s) => s.sessionOptionsMultilineMode);
  const multilineHeader = useImportStore((s) => s.sessionOptionsMultilineHeaderPattern);
  const multilineKey = `${multilineEnabled}|${multilineMode}|${multilineHeader}`;

  const currentMultiline = useCallback(() => sessionMultilineOption(useImportStore.getState()), []);

  const detectOne = useCallback(
    async (fileId: string) => {
      const store = useImportStore.getState();
      const file = store.files.find((f) => f.id === fileId);
      if (!file) return;
      const outcome = await detectPatternForFile(file, {
        availablePatterns: store.availablePatterns,
        multiline: currentMultiline(),
      });
      const after = useImportStore.getState();
      // The file may have been removed while detection ran.
      if (!after.files.some((f) => f.id === fileId)) return;
      if (outcome.detectedMultiline) {
        const m = outcome.detectedMultiline;
        const mode = m.mode === 'indent' || m.mode === 'header' ? m.mode : 'header';
        autoAppliedMultilineKey.current = `true|${mode}|${m.header_pattern || ''}`;
        after.setSessionOptionMultilineEnabled(true);
        after.setSessionOptionMultilineMode(mode);
        after.setSessionOptionMultilineHeaderPattern(m.header_pattern || '');
      }
      after.updateFile(fileId, outcome.updates);
      if (outcome.inference) after.setFileTimestampInference(fileId, outcome.inference);
    },
    [currentMultiline]
  );

  const pump = useCallback(() => {
    while (inFlight.current.size < DETECT_CONCURRENCY && queue.current.length > 0) {
      const id = queue.current.shift()!;
      if (inFlight.current.has(id)) continue;
      inFlight.current.add(id);
      detectOne(id).finally(() => {
        inFlight.current.delete(id);
        pump();
      });
    }
  }, [detectOne]);

  const enqueue = useCallback(
    (ids: string[]) => {
      const store = useImportStore.getState();
      for (const id of ids) {
        if (inFlight.current.has(id) || queue.current.includes(id)) continue;
        store.updateFile(id, { detectionStatus: 'detecting' });
        queue.current.push(id);
      }
      pump();
    },
    [pump]
  );

  // New files: anything still `pending` has never been detected.
  useEffect(() => {
    const pending = files.filter((f) => f.detectionStatus === 'pending').map((f) => f.id);
    if (pending.length > 0) enqueue(pending);
  }, [files, enqueue]);

  // The list was emptied (reset / navigate away): forget queued work.
  useEffect(() => {
    if (files.length === 0) queue.current = [];
  }, [files.length]);

  const redetectAll = useCallback(() => {
    const ids = useImportStore.getState().files.map((f) => f.id);
    // Drop previewLines? No -- keep them; detection reuses the read. Only
    // the pattern verdict is recomputed.
    enqueue(ids);
  }, [enqueue]);

  // Multiline changed by the user → re-detect every file against the new
  // folding. Skipped on first render and when the change was detection's
  // own auto-apply (that batch already used the new config).
  const lastSeenKey = useRef(multilineKey);
  useEffect(() => {
    if (lastSeenKey.current === multilineKey) return;
    lastSeenKey.current = multilineKey;
    if (autoAppliedMultilineKey.current === multilineKey) return;
    if (useImportStore.getState().files.length === 0) return;
    const timer = window.setTimeout(redetectAll, MULTILINE_REDETECT_MS);
    return () => window.clearTimeout(timer);
  }, [multilineKey, redetectAll]);

  // User picked (or edited) a pattern for one file: re-parse its preview.
  const changePattern = useCallback(
    async (fileId: string, pattern: Pattern) => {
      const store = useImportStore.getState();
      const file = store.files.find((f) => f.id === fileId);
      if (!file) return;
      store.updateFile(fileId, { detectionStatus: 'detecting' });
      const { updates, inference } = await parseFileWithPattern(file, pattern, currentMultiline());
      const after = useImportStore.getState();
      if (!after.files.some((f) => f.id === fileId)) return;
      after.updateFile(fileId, updates);
      if (inference) after.setFileTimestampInference(fileId, inference);
    },
    [currentMultiline]
  );

  // "Apply <pattern> to all N files": set, then re-parse each so match
  // rates and previews reflect the new choice.
  const applyPatternToAll = useCallback(
    async (pattern: Pattern) => {
      const store = useImportStore.getState();
      store.setAllFilesPattern(pattern);
      await Promise.all(store.files.map((f) => changePattern(f.id, pattern)));
    },
    [changePattern]
  );

  const isDetecting = files.some(
    (f) => f.detectionStatus === 'detecting' || f.detectionStatus === 'pending'
  );

  return { changePattern, applyPatternToAll, redetectAll, isDetecting };
}

export default useFileDetection;
