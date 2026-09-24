import type { FileMultiline } from '../types';
import type { MultilineConfig } from '@/lib/api-types';

// Presets mirror log2grok's CommonMultilineConfigs() so the import
// surface's choices stay consistent with the backend's own ready-made
// configs. The state shape is the per-file `FileMultiline`, which
// useUpload.ts sends on that file's ingest session.
export const ISO8601_HEADER_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`;
export const SYSLOG_HEADER_PATTERN = String.raw`^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2}`;

export type MultilinePreset = 'off' | 'indent' | 'iso8601' | 'syslog' | 'regex';

export const MULTILINE_PRESETS: { id: MultilinePreset; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'indent', label: 'Indent-based' },
  { id: 'iso8601', label: 'ISO8601' },
  { id: 'syslog', label: 'Syslog' },
  { id: 'regex', label: 'Regex' },
];

export function presetFromState(state: FileMultiline): MultilinePreset {
  if (!state.enabled) return 'off';
  if (state.mode === 'indent') return 'indent';
  if (state.headerPattern === ISO8601_HEADER_PATTERN) return 'iso8601';
  if (state.headerPattern === SYSLOG_HEADER_PATTERN) return 'syslog';
  return 'regex';
}

// The per-file state a preset maps onto. `regex` keeps whatever custom
// header pattern is already there (so switching away and back doesn't
// lose the user's regex) unless that pattern is one of the presets.
export function stateFromPreset(preset: MultilinePreset, current: FileMultiline): FileMultiline {
  switch (preset) {
    case 'off':
      return { ...current, enabled: false };
    case 'indent':
      return { enabled: true, mode: 'indent', headerPattern: '' };
    case 'iso8601':
      return { enabled: true, mode: 'header', headerPattern: ISO8601_HEADER_PATTERN };
    case 'syslog':
      return { enabled: true, mode: 'header', headerPattern: SYSLOG_HEADER_PATTERN };
    case 'regex': {
      const keep =
        current.mode === 'header' &&
        current.headerPattern !== ISO8601_HEADER_PATTERN &&
        current.headerPattern !== SYSLOG_HEADER_PATTERN
          ? current.headerPattern
          : '';
      return { enabled: true, mode: 'header', headerPattern: keep };
    }
  }
}

// The API shape for a file's folding. Off is sent explicitly: POST /parse
// auto-detects a layout only when the field is absent, and the preview
// must show what /ingest/start (which never auto-detects) will produce.
export function multilineConfigOf(m: FileMultiline): MultilineConfig {
  if (!m.enabled) return { enabled: false, mode: m.mode };
  return { enabled: true, mode: m.mode, header_pattern: m.headerPattern || undefined };
}

// Header mode with a blank pattern would fold every line into one record.
export function isHeaderPatternMissing(m: FileMultiline): boolean {
  return m.enabled && m.mode === 'header' && !m.headerPattern.trim();
}

// The per-file state for a config the suggester found, or null when it
// found none. Modes outside header/indent fall back to header.
export function multilineFromConfig(c: MultilineConfig | null | undefined): FileMultiline | null {
  if (!c?.enabled) return null;
  return {
    enabled: true,
    mode: c.mode === 'indent' ? 'indent' : 'header',
    headerPattern: c.header_pattern || '',
  };
}

// Short label for a file's folding, for the rail and the Options caption.
export function multilineLabel(m: FileMultiline): string | null {
  if (!m.enabled) return null;
  switch (presetFromState(m)) {
    case 'indent':
      return 'indent';
    case 'iso8601':
      return 'ISO8601';
    case 'syslog':
      return 'syslog';
    default:
      return 'regex';
  }
}
