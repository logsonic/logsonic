import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';

import { multilineConfigOf } from '../utils/multilinePresets';
import {
  buildState,
  currentYearChoice,
  dayPatch,
  describeOverrides,
  effectiveResolution,
  monthPatch,
  MONTHS,
  parseResolved,
  timezonePatch,
  yearPatch,
} from '../utils/timestampParts';

import { TimezonePicker } from './TimezonePicker';

import type { ImportFile } from '../types';
import type { Comp, PartState, YearChoice } from '../utils/timestampParts';
import type { FieldCandidate, TimestampResolution } from '@/lib/api-types';

import { previewTimestamps } from '@/lib/api-client';
import { useImportStore } from '@/stores/useImportStore';

type Picker = 'year' | 'month' | 'day' | 'tz';

interface TimestampTabProps {
  file: ImportFile;
  fileCount: number;
}

// Tile tone from the part's provenance. `manual` wins whenever the user
// has an override on that part.
function tileTone(comp: Comp, st: PartState, overrides: Partial<TimestampResolution>): string {
  const manual =
    (comp === 'year' && overrides.year_strategy != null) ||
    (comp === 'month' && overrides.forced_month !== undefined) ||
    (comp === 'day' && overrides.forced_day !== undefined) ||
    (comp === 'tz' && overrides.timezone != null);
  if (manual) return 'ls-imp-tile--manual';
  if (!st.filled) return 'ls-imp-tile--log';
  if (st.src === 'default' || st.src === 'as captured') return '';
  return 'ls-imp-tile--inferred';
}

function tileSource(comp: Comp, st: PartState, overrides: Partial<TimestampResolution>): string {
  if (tileTone(comp, st, overrides) === 'ls-imp-tile--manual') return 'manual override';
  if (!st.filled) return 'from log';
  switch (st.src) {
    case 'file date':
      return 'inferred from mtime';
    case 'this year':
      return 'assumed this year';
    case 'default':
      return comp === 'tz' ? 'assumed UTC' : 'assumed';
    case 'fixed':
    case 'forced':
      return 'from saved pattern';
    default:
      return st.src;
  }
}

export const TimestampTab: FC<TimestampTabProps> = ({ file, fileCount }) => {
  const patch = useImportStore((s) => s.patchFileTimestampOverride);
  const setOverrides = useImportStore((s) => s.setFileTimestampOverrides);
  const setConfirmed = useImportStore((s) => s.setFileTimestampConfirmed);
  const setInference = useImportStore((s) => s.setFileTimestampInference);
  const applyToAll = useImportStore((s) => s.applyTimestampToAllFiles);
  const updateFileSessionOptions = useImportStore((s) => s.updateFileSessionOptions);

  const [picker, setPicker] = useState<Picker | null>(null);
  const [customYear, setCustomYear] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [appliedAll, setAppliedAll] = useState(false);
  const debounceRef = useRef<number | null>(null);

  const inference = file.timestampInference;
  const overrides = file.timestampOverrides;
  const eff = useMemo(() => effectiveResolution(inference, overrides), [inference, overrides]);
  const hasOverrides = Object.keys(overrides).length > 0;

  // Debounced live re-preview against /timestamp/preview when knobs
  // change, so the tiles, the format line and the preview gutter reflect
  // the override. Ported from the wizard's TimestampToolbar.
  const overridesKey = JSON.stringify(overrides);
  useEffect(() => {
    if (!inference || !file.selectedPattern || file.previewLines.length === 0 || !hasOverrides)
      return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const fileId = file.id;
    debounceRef.current = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await previewTimestamps({
          logs: file.previewLines.slice(0, 20),
          grok_pattern: file.selectedPattern!.pattern,
          custom_patterns: file.selectedPattern!.custom_patterns || {},
          resolution: eff || {},
          source_mtime: file.sourceMTime || undefined,
          multiline: multilineConfigOf(file.sessionOptions.multiline),
        });
        if (
          res.status === 'success' &&
          useImportStore.getState().files.some((f) => f.id === fileId)
        ) {
          // Keep the user's confirmation: setFileTimestampInference would
          // re-derive it from the status, but the user has already looked.
          const confirmed = useImportStore
            .getState()
            .files.find((f) => f.id === fileId)?.timestampConfirmed;
          setInference(fileId, res.inference);
          if (confirmed) setConfirmed(fileId, true);
        }
      } finally {
        setPreviewing(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overridesKey, file.id, file.selectedPattern?.pattern]);

  if (!inference || !eff) {
    const busy = file.detectionStatus === 'detecting' || file.detectionStatus === 'pending';
    return (
      <div className="ls-imp-card" style={{ fontSize: 12.5, color: 'var(--ls-text-3)' }}>
        {busy
          ? 'Waiting for detection to finish…'
          : 'No timestamp verdict yet — the pattern has not parsed any preview line.'}
      </div>
    );
  }

  const parts = parseResolved(inference.preview?.[0]?.resolved);
  const st = buildState(inference, eff, parts);
  const status = inference.status;
  const needsConfirm = (status === 'ambiguous' || status === 'missing') && !file.timestampConfirmed;
  const resolvedExample = inference.preview?.[0]?.resolved;
  const mtimeYear = file.sourceMTime ? new Date(file.sourceMTime).getFullYear() : null;
  const nowYear = new Date().getFullYear();
  const yearFromLog = inference.layout.year_width > 0;
  const yearChoice = currentYearChoice(eff, { mtimeYear, nowYear });

  // "Which column is the time" -- surfaced only when there is a real choice
  // (several fields parse, a source is pinned, or the auto pick failed).
  const tsCandidates: FieldCandidate[] = (inference.field_candidates || []).filter((c) => c.parses);
  const autoFailed =
    inference.preview?.[0]?.confidence === 'synthetic' ||
    status === 'missing' ||
    status === 'ambiguous';
  const showSource =
    tsCandidates.length >= 2 || !!eff.source_field || (tsCandidates.length >= 1 && autoFailed);
  const pickSource = (c: FieldCandidate | null) =>
    patch(
      file.id,
      c
        ? { source_field: c.name, source_format: c.format && c.format !== 'auto' ? c.format : '' }
        : { source_field: '', source_format: '' }
    );

  const applyYear = (choice: YearChoice) => {
    const p = yearPatch(choice, { mtimeYear, nowYear, custom: parseInt(customYear, 10) });
    if (p) patch(file.id, p);
  };

  const tiles: { comp: Comp; label: string; picker: Picker }[] = [
    { comp: 'year', label: 'Year', picker: 'year' },
    { comp: 'month', label: 'Month', picker: 'month' },
    { comp: 'day', label: 'Day', picker: 'day' },
    { comp: 'tz', label: 'Timezone', picker: 'tz' },
  ];
  const tileValue = (comp: Comp) =>
    comp === 'month' && /^\d{2}$/.test(st.month.value)
      ? MONTHS[parseInt(st.month.value, 10) - 1]
      : st[comp].value;

  const summary = describeOverrides(overrides);
  const formatLabel = inference.layout.inferred_format_label;

  return (
    <div className="ls-rise">
      {/* status card */}
      {needsConfirm || status === 'ambiguous' || status === 'missing' ? (
        <div className="ls-imp-card ls-imp-card--warn">
          <div className="flex items-start" style={{ gap: 8 }}>
            <AlertTriangle
              size={14}
              style={{ color: 'var(--ls-warn)', flexShrink: 0, marginTop: 2 }}
            />
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ls-warn)' }}>
                {status === 'missing' ? 'No timestamp found' : 'Timestamp is ambiguous'}
              </div>
              {(inference.warnings || []).map((w, i) => (
                <div key={i} style={{ marginTop: 4, fontSize: 12, color: 'var(--ls-warn)' }}>
                  {w}
                </div>
              ))}
              {resolvedExample && (
                <div
                  className="ls-imp-mono"
                  style={{ marginTop: 6, fontSize: 11.5, color: 'var(--ls-text-2)' }}
                >
                  first line resolves to {resolvedExample}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                {file.timestampConfirmed ? (
                  <span
                    className="inline-flex items-center"
                    style={{ gap: 4, fontSize: 12, color: 'var(--ls-ok)' }}
                  >
                    <Check size={12} /> Confirmed — import can proceed
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ls-imp-btn"
                    onClick={() => setConfirmed(file.id, true)}
                  >
                    Looks correct
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="ls-imp-card ls-imp-card--ok">
          <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
            <span
              className="inline-flex items-center"
              style={{ gap: 5, fontSize: 13, fontWeight: 600, color: 'var(--ls-ok)' }}
            >
              <Check size={13} /> {status === 'inferred' ? 'Inferred' : 'Detected'}
              {previewing && (
                <Loader2 size={11} className="animate-spin" style={{ color: 'var(--ls-text-3)' }} />
              )}
            </span>
            {resolvedExample && (
              <span
                className="ls-imp-mono truncate"
                style={{ fontSize: 12, color: 'var(--ls-ok)' }}
              >
                {resolvedExample}
              </span>
            )}
          </div>
          {(formatLabel || summary.length > 0) && (
            <div
              className="ls-imp-mono"
              style={{ marginTop: 4, fontSize: 11.5, color: 'var(--ls-text-2)' }}
            >
              {formatLabel}
              {summary.length > 0 && ` · ${summary.length} overridden`}
            </div>
          )}
          {(inference.warnings || []).map((w, i) => (
            <div key={i} style={{ marginTop: 6, fontSize: 11.5, color: 'var(--ls-warn)' }}>
              {w}
            </div>
          ))}
        </div>
      )}

      {/* time source switch */}
      {showSource && (
        <>
          <div className="ls-imp-label" style={{ margin: '16px 0 8px' }}>
            Time source
          </div>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            <button
              type="button"
              className={`ls-imp-opt${!eff.source_field ? ' ls-imp-opt--selected' : ''}`}
              onClick={() => pickSource(null)}
            >
              Auto-detect
              <small>canonical scan</small>
            </button>
            {tsCandidates.map((c) => (
              <button
                key={c.name}
                type="button"
                className={`ls-imp-opt${eff.source_field === c.name ? ' ls-imp-opt--selected' : ''}`}
                onClick={() => pickSource(c)}
                title={c.sample}
              >
                {c.name}
                <small className="truncate" style={{ maxWidth: 160 }}>
                  {c.sample}
                </small>
              </button>
            ))}
          </div>
        </>
      )}

      {/* resolution tiles */}
      <div className="ls-imp-label" style={{ margin: '16px 0 8px' }}>
        Resolution
      </div>
      <div className="ls-imp-tiles">
        {tiles.map(({ comp, label, picker: p }) => (
          <button
            key={comp}
            type="button"
            className={`ls-imp-tile ${tileTone(comp, st[comp], overrides)}${picker === p ? ' ls-imp-tile--open' : ''}`}
            onClick={() => setPicker(picker === p ? null : p)}
            aria-expanded={picker === p}
            title={`${st[comp].value} — ${st[comp].filled ? 'filled in' : 'read from the log'} (${st[comp].src}) · click to change`}
          >
            <span className="ls-imp-tile-label">{label}</span>
            <span className="ls-imp-tile-value">{tileValue(comp)}</span>
            <span className="ls-imp-tile-src">{tileSource(comp, st[comp], overrides)}</span>
          </button>
        ))}
      </div>

      {/* override picker */}
      {picker && (
        <div className="ls-imp-picker">
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <span className="ls-imp-label" style={{ fontSize: 11, color: 'var(--ls-accent-text)' }}>
              Override {picker === 'tz' ? 'timezone' : picker}
            </span>
            <button
              type="button"
              className="ls-imp-link"
              style={{ color: 'var(--ls-text-3)' }}
              onClick={() => setPicker(null)}
            >
              Close
            </button>
          </div>

          {picker === 'year' && (
            <div className="flex flex-wrap" style={{ gap: 6 }}>
              <button
                type="button"
                className={`ls-imp-opt${yearChoice === 'parsed' ? ' ls-imp-opt--selected' : ''}`}
                disabled={!yearFromLog}
                onClick={() => applyYear('parsed')}
              >
                {yearFromLog ? st.year.value : '—'}
                <small>{yearFromLog ? 'parsed from line' : 'log has no year'}</small>
              </button>
              <button
                type="button"
                className={`ls-imp-opt${yearChoice === 'file_mtime' ? ' ls-imp-opt--selected' : ''}`}
                disabled={mtimeYear == null}
                onClick={() => applyYear('file_mtime')}
              >
                {mtimeYear ?? '—'}
                <small>file mtime</small>
              </button>
              <button
                type="button"
                className={`ls-imp-opt${yearChoice === 'now' ? ' ls-imp-opt--selected' : ''}`}
                onClick={() => applyYear('now')}
              >
                {nowYear}
                <small>this year</small>
              </button>
              <button
                type="button"
                className={`ls-imp-opt${yearChoice === 'previous' ? ' ls-imp-opt--selected' : ''}`}
                onClick={() => applyYear('previous')}
              >
                {nowYear - 1}
                <small>previous year</small>
              </button>
              <input
                className="ls-imp-input ls-imp-input--mono"
                style={{ width: 96 }}
                placeholder="YYYY"
                inputMode="numeric"
                maxLength={4}
                value={customYear}
                onChange={(e) => setCustomYear(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyYear('custom');
                }}
                onBlur={() => {
                  if (customYear.length === 4) applyYear('custom');
                }}
                aria-label="Custom year"
              />
            </div>
          )}

          {picker === 'month' && (
            <div className="flex flex-wrap" style={{ gap: 6 }}>
              <button
                type="button"
                className={`ls-imp-opt${eff.forced_month == null ? ' ls-imp-opt--selected' : ''}`}
                onClick={() => patch(file.id, monthPatch(null))}
              >
                Auto
                <small>from log</small>
              </button>
              {MONTHS.map((m, i) => (
                <button
                  key={m}
                  type="button"
                  className={`ls-imp-opt${eff.forced_month === i + 1 ? ' ls-imp-opt--selected' : ''}`}
                  onClick={() => patch(file.id, monthPatch(i + 1))}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {picker === 'day' && (
            <div className="flex flex-wrap" style={{ gap: 5 }}>
              <button
                type="button"
                className={`ls-imp-opt${eff.forced_day == null ? ' ls-imp-opt--selected' : ''}`}
                onClick={() => patch(file.id, dayPatch(null))}
              >
                Auto
              </button>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`ls-imp-opt${eff.forced_day === d ? ' ls-imp-opt--selected' : ''}`}
                  style={{ minWidth: 34, justifyContent: 'center', alignItems: 'center' }}
                  onClick={() => patch(file.id, dayPatch(d))}
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          {picker === 'tz' && (
            <TimezonePicker
              value={eff.timezone.kind === 'forced' ? eff.timezone.value || 'UTC' : null}
              onChange={(tz) => {
                patch(file.id, timezonePatch(tz));
                // Mirror into the legacy per-file option so an upload without
                // an inference (no parsed line) still honours the choice.
                updateFileSessionOptions(file.id, { timezone: tz ?? '' });
              }}
            />
          )}

          <div
            className="flex items-center justify-between"
            style={{
              gap: 8,
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid var(--ls-accent-border)',
            }}
          >
            <button
              type="button"
              className="ls-imp-link"
              onClick={() => {
                setOverrides(file.id, {});
                updateFileSessionOptions(file.id, { timezone: '' });
                setCustomYear('');
              }}
              disabled={!hasOverrides}
            >
              Reset to detected
            </button>
            <span style={{ fontSize: 11, color: 'var(--ls-text-3)', textAlign: 'right' }}>
              {picker === 'tz'
                ? 'applies to every line without an explicit offset'
                : 'applies to every line of this file'}
            </span>
          </div>
        </div>
      )}

      {/* override summary */}
      {summary.length > 0 && (
        <div
          className="ls-imp-card ls-imp-card--accent flex items-center justify-between"
          style={{ gap: 8, marginTop: 10, padding: '8px 10px' }}
        >
          <span style={{ fontSize: 11.5, color: 'var(--ls-accent-text)' }}>
            {summary.length} manual override{summary.length === 1 ? '' : 's'}: {summary.join(', ')}
          </span>
          <button
            type="button"
            className="ls-imp-link flex-shrink-0"
            onClick={() => {
              setOverrides(file.id, {});
              updateFileSessionOptions(file.id, { timezone: '' });
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {fileCount > 1 && (
        <div style={{ marginTop: 14 }}>
          {appliedAll ? (
            <span style={{ fontSize: 12, color: 'var(--ls-ok)' }}>
              ✓ Applied to all {fileCount} files
            </span>
          ) : (
            <button
              type="button"
              className="ls-imp-link"
              style={{ fontSize: 12 }}
              onClick={() => {
                applyToAll(file.id);
                setAppliedAll(true);
              }}
            >
              Apply timestamp settings to all files →
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TimestampTab;
