import { ChevronDown } from 'lucide-react';
import { FC, useEffect, useRef, useState } from 'react';

import {
  isHeaderPatternMissing,
  MULTILINE_PRESETS,
  presetFromState,
  stateFromPreset,
} from '../utils/multilinePresets';
import { timezonePatch } from '../utils/timestampParts';

import { TimezonePicker } from './TimezonePicker';

import type { FileMultiline, ImportFile } from '../types';

import { Switch } from '@/components/ui/switch';
import { useImportStore } from '@/stores/useImportStore';

interface OptionsTabProps {
  file: ImportFile;
  fileCount: number;
  // Re-parse a file's preview after its multiline folding changed.
  onReparse: (fileId: string) => Promise<void>;
}

// Typing a header regex re-parses the preview per keystroke otherwise.
const REGEX_REPARSE_MS = 400;

const Group: FC<{
  title: string;
  description: string;
  control?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, description, control, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div className="flex items-start justify-between" style={{ gap: 12 }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ls-text)' }}>{title}</div>
        <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ls-text-3)' }}>{description}</div>
      </div>
      {control}
    </div>
    {children && <div style={{ marginTop: 8 }}>{children}</div>}
  </div>
);

/**
 * Per-file ingest options: the upload path reads `sessionOptions` per
 * file, so every group here -- smart decoder, forced timezone and the
 * multiline folding -- applies to this file's ingest session only. A
 * folding change re-parses the file's preview so the verdict reflects it.
 */
export const OptionsTab: FC<OptionsTabProps> = ({ file, fileCount, onReparse }) => {
  const updateFileSessionOptions = useImportStore((s) => s.updateFileSessionOptions);
  const patchOverride = useImportStore((s) => s.patchFileTimestampOverride);

  const [tzOpen, setTzOpen] = useState(false);
  const [appliedAll, setAppliedAll] = useState(false);
  const regexTimer = useRef<number | null>(null);

  const multiline = file.sessionOptions.multiline;
  const preset = presetFromState(multiline);

  const setMultiline = (next: FileMultiline, debounce = false) => {
    updateFileSessionOptions(file.id, { multiline: next });
    if (regexTimer.current) window.clearTimeout(regexTimer.current);
    if (isHeaderPatternMissing(next)) return; // the gate explains; nothing to parse yet
    if (debounce) {
      regexTimer.current = window.setTimeout(() => onReparse(file.id), REGEX_REPARSE_MS);
    } else {
      onReparse(file.id);
    }
  };
  useEffect(
    () => () => {
      if (regexTimer.current) window.clearTimeout(regexTimer.current);
    },
    []
  );
  const forcedTz =
    file.timestampOverrides.timezone?.kind === 'forced'
      ? file.timestampOverrides.timezone.value || 'UTC'
      : null;

  const setTz = (tz: string | null) => {
    patchOverride(file.id, timezonePatch(tz));
    updateFileSessionOptions(file.id, { timezone: tz ?? '' });
    setTzOpen(false);
  };

  return (
    <div className="ls-rise">
      <Group
        title="Smart decoder"
        description="Auto-detect JSON/CSV inside log lines"
        control={
          <Switch
            className="ls-imp-switch"
            checked={file.sessionOptions.smartDecoder}
            onCheckedChange={(v) => updateFileSessionOptions(file.id, { smartDecoder: v })}
            aria-label="Smart decoder"
          />
        }
      />

      <Group title="Force timezone" description="Override the timezone from auto-detection">
        <button
          type="button"
          className="ls-imp-select"
          onClick={() => setTzOpen((v) => !v)}
          aria-expanded={tzOpen}
        >
          <span className="truncate">{forcedTz ?? 'Auto (from detection)'}</span>
          <ChevronDown size={13} style={{ color: 'var(--ls-text-3)', flexShrink: 0 }} />
        </button>
        {tzOpen && (
          <div className="ls-imp-picker" style={{ marginTop: 6 }}>
            <TimezonePicker value={forcedTz} onChange={setTz} />
          </div>
        )}
      </Group>

      <Group title="Multiline records" description="Join continuation lines to the record above">
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          {MULTILINE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`ls-imp-chip${preset === p.id ? ' ls-imp-chip--selected' : ''}`}
              onClick={() => {
                if (preset !== p.id) setMultiline(stateFromPreset(p.id, multiline));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'regex' && (
          <input
            className="ls-imp-input ls-imp-input--mono ls-rise"
            style={{ marginTop: 8 }}
            placeholder={String.raw`e.g. ^\s+|^\d{4}-`}
            value={multiline.headerPattern}
            onChange={(e) => setMultiline({ ...multiline, headerPattern: e.target.value }, true)}
            aria-label="New-record regex"
          />
        )}
        {preset !== 'off' && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--ls-text-3)' }}>
            Applies to this file only; the preview re-parses with the new folding.
          </div>
        )}
      </Group>

      {fileCount > 1 &&
        (appliedAll ? (
          <span style={{ fontSize: 12, color: 'var(--ls-ok)' }}>
            ✓ Applied to all {fileCount} files
          </span>
        ) : (
          <button
            type="button"
            className="ls-imp-link"
            style={{ fontSize: 12 }}
            onClick={() => {
              // Everything but the folding: multiline is what a file's own
              // detection found in it, and stamping one file's header onto
              // the rest is exactly how a batch collapses.
              const { multiline: _own, ...shared } = file.sessionOptions;
              const tzPatch = timezonePatch(forcedTz);
              useImportStore
                .getState()
                .files.filter((f) => f.id !== file.id)
                .forEach((f) => {
                  updateFileSessionOptions(f.id, shared);
                  if (forcedTz || f.timestampOverrides.timezone) patchOverride(f.id, tzPatch);
                });
              setAppliedAll(true);
            }}
            title="Smart decoder and timezone; multiline folding stays per file"
          >
            Apply decoder &amp; timezone to all files →
          </button>
        ))}
    </div>
  );
};

export default OptionsTab;
