import { ChevronDown } from 'lucide-react';
import { FC, useState } from 'react';

import { MULTILINE_PRESETS, presetFromState, stateFromPreset } from '../utils/multilinePresets';
import { timezonePatch } from '../utils/timestampParts';

import { TimezonePicker } from './TimezonePicker';

import type { ImportFile } from '../types';

import { Switch } from '@/components/ui/switch';
import { useImportStore } from '@/stores/useImportStore';

interface OptionsTabProps {
  file: ImportFile;
  fileCount: number;
}

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
 * Per-file ingest options. Smart decoder and the forced timezone are
 * per-file (the upload path reads `sessionOptions` per file); multiline
 * folding is a session-wide setting (useUpload sends the store's global
 * triple) and re-runs detection for every file when changed.
 */
export const OptionsTab: FC<OptionsTabProps> = ({ file, fileCount }) => {
  const updateFileSessionOptions = useImportStore((s) => s.updateFileSessionOptions);
  const patchOverride = useImportStore((s) => s.patchFileTimestampOverride);
  const setAllFilesOptions = useImportStore((s) => s.setAllFilesOptions);
  const multilineEnabled = useImportStore((s) => s.sessionOptionsMultilineEnabled);
  const multilineMode = useImportStore((s) => s.sessionOptionsMultilineMode);
  const multilineHeader = useImportStore((s) => s.sessionOptionsMultilineHeaderPattern);
  const setMultilineEnabled = useImportStore((s) => s.setSessionOptionMultilineEnabled);
  const setMultilineMode = useImportStore((s) => s.setSessionOptionMultilineMode);
  const setMultilineHeader = useImportStore((s) => s.setSessionOptionMultilineHeaderPattern);

  const [tzOpen, setTzOpen] = useState(false);
  const [appliedAll, setAppliedAll] = useState(false);

  const multilineState = {
    sessionOptionsMultilineEnabled: multilineEnabled,
    sessionOptionsMultilineMode: multilineMode,
    sessionOptionsMultilineHeaderPattern: multilineHeader,
  };
  const preset = presetFromState(multilineState);
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
                const next = stateFromPreset(p.id, multilineState);
                setMultilineEnabled(next.sessionOptionsMultilineEnabled);
                setMultilineMode(next.sessionOptionsMultilineMode);
                setMultilineHeader(next.sessionOptionsMultilineHeaderPattern);
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
            value={multilineHeader}
            onChange={(e) => setMultilineHeader(e.target.value)}
            aria-label="New-record regex"
          />
        )}
        {preset !== 'off' && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--ls-text-3)' }}>
            Applies to every file in this import; detection re-runs with the new folding.
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
              setAllFilesOptions(file.sessionOptions);
              const tzPatch = timezonePatch(forcedTz);
              useImportStore
                .getState()
                .files.filter((f) => f.id !== file.id)
                .forEach((f) => {
                  if (forcedTz || f.timestampOverrides.timezone) patchOverride(f.id, tzPatch);
                });
              setAppliedAll(true);
            }}
          >
            Apply these options to all files →
          </button>
        ))}
    </div>
  );
};

export default OptionsTab;
