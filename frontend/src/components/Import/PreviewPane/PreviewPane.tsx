import { FileText, Loader2 } from 'lucide-react';
import { FC, useMemo } from 'react';

import { matchRateOf } from '../hooks/useFileDetection';
import { fieldTones, segmentLine } from '../utils/fieldTone';

import type { ImportFile } from '../types';
import type { TimestampInference } from '@/lib/api-types';

interface PreviewPaneProps {
  file: ImportFile | null;
  onTestAnotherPattern: () => void;
}

// Resolved timestamp + confidence for a preview row, from the inference's
// own preview window; rows past it have no verdict.
function rowVerdict(inference: TimestampInference | null, index: number) {
  const p = inference?.preview?.[index];
  return p ? { resolved: p.resolved, confidence: p.confidence } : null;
}

/**
 * Right pane: the selected file's first preview lines with every parsed
 * field washed in its tone. Replaces the wizard's PatternTestResults table;
 * the resolved timestamp verdict lives in the gutter's tooltip and its
 * color (amber = the resolver had to guess, red = it could not).
 */
export const PreviewPane: FC<PreviewPaneProps> = ({ file, onTestAnotherPattern }) => {
  const rows = useMemo(() => {
    if (!file) return [];
    const parsed = file.parsedLogs;
    const hasRaw = parsed.some((l) => typeof l._raw === 'string' && l._raw);
    const lines = hasRaw ? parsed.map((l) => String(l._raw)) : file.previewLines;
    const fieldNames = Array.from(
      new Set(parsed.flatMap((l) => Object.keys(l).filter((k) => !k.startsWith('_'))))
    );
    const tones = fieldTones(fieldNames);
    return lines.map((raw, i) => {
      const p = parsed[i];
      const ok = p && !p.error;
      // The resolver normalises timestamps (and may rewrite other
      // captures); the inference's `captured` map keeps the raw text so
      // those fields can still be located in the line.
      const captured = file.timestampInference?.preview?.[i]?.captured;
      const located = ok && captured ? { ...p, ...captured } : p;
      return {
        raw,
        segments: segmentLine(raw, ok ? located : undefined, tones),
        failed: !!(p && p.error),
        verdict: rowVerdict(file.timestampInference, i),
      };
    });
  }, [file]);

  if (!file) {
    return (
      <section className="ls-imp-pane" aria-label="Preview">
        <div className="ls-imp-pane-head">
          <span className="ls-imp-label">Preview</span>
        </div>
        <div
          className="flex flex-1 flex-col items-center justify-center"
          style={{ gap: 8, color: 'var(--ls-text-4)' }}
        >
          <FileText size={22} />
          <span style={{ fontSize: 12.5 }}>Select a file to see its preview</span>
        </div>
      </section>
    );
  }

  const detecting = file.detectionStatus === 'detecting' || file.detectionStatus === 'pending';
  const matchRate =
    file.detectionStatus === 'detected' ? matchRateOf(file.parsedLogs, file.previewLines) : null;
  const remaining = Math.max(0, file.approxLines - rows.length);

  return (
    <section className="ls-imp-pane" aria-label="Preview">
      <div className="ls-imp-pane-head">
        <span className="ls-imp-label">Preview</span>
        <span className="ls-imp-mono truncate" style={{ fontSize: 12, color: 'var(--ls-text)' }}>
          {file.fileName}
        </span>
        <span
          className="ls-imp-mono ml-auto flex items-center flex-shrink-0"
          style={{ gap: 6, fontSize: 11, color: 'var(--ls-text-4)' }}
        >
          {detecting ? (
            <>
              <Loader2 size={11} className="animate-spin" /> detecting…
            </>
          ) : file.selectedPattern ? (
            <>
              {file.selectedPattern.name}
              {matchRate != null && ` · ${matchRate}% match`}
            </>
          ) : (
            'no pattern'
          )}
        </span>
      </div>

      <div className="ls-imp-pane-scroll" style={{ padding: '6px 0' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '24px 14px', fontSize: 12.5, color: 'var(--ls-text-3)' }}>
            {detecting
              ? 'Reading the first lines…'
              : 'No preview lines could be read from this file.'}
          </div>
        ) : (
          rows.map((row, i) => {
            const conf = row.verdict?.confidence;
            const gutterTone =
              row.failed || conf === 'synthetic'
                ? 'ls-imp-gutter--err'
                : conf === 'inferred' || conf === 'carried'
                  ? 'ls-imp-gutter--warn'
                  : '';
            const title = row.failed
              ? 'This line did not match the pattern'
              : row.verdict
                ? `${row.verdict.confidence}: ${row.verdict.resolved}`
                : undefined;
            return (
              <div key={i} className="ls-imp-prow">
                <span className={`ls-imp-gutter ${gutterTone}`} title={title}>
                  {i + 1}
                </span>
                <div className="ls-imp-line">
                  {row.failed ? (
                    <span className="ls-imp-field ls-imp-field--muted">{row.raw}</span>
                  ) : (
                    row.segments.map((seg, j) => (
                      <span
                        key={j}
                        className={`ls-imp-field ls-imp-field--${seg.tone}`}
                        title={seg.field ? `${seg.field}: ${seg.text}` : undefined}
                      >
                        {seg.text}
                      </span>
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="ls-imp-pane-foot">
        <span className="ls-imp-mono" style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>
          {remaining > 0 ? `~${remaining.toLocaleString()} more lines` : `${rows.length} lines`}
        </span>
        <button type="button" className="ls-imp-link" onClick={onTestAnotherPattern}>
          Test with another pattern →
        </button>
      </div>
    </section>
  );
};

export default PreviewPane;
