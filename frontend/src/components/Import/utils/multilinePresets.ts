// Presets mirror log2grok's CommonMultilineConfigs() so the import
// surface's choices stay consistent with the backend's own ready-made
// configs. The state shape is the store's global multiline triple, which
// useUpload.ts sends on every ingest session.
export const ISO8601_HEADER_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`;
export const SYSLOG_HEADER_PATTERN = String.raw`^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2}`;

export type MultilinePreset = 'off' | 'indent' | 'iso8601' | 'syslog' | 'regex';

export interface MultilineState {
  sessionOptionsMultilineEnabled: boolean;
  sessionOptionsMultilineMode: 'header' | 'indent';
  sessionOptionsMultilineHeaderPattern: string;
}

export const MULTILINE_PRESETS: { id: MultilinePreset; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'indent', label: 'Indent-based' },
  { id: 'iso8601', label: 'ISO8601' },
  { id: 'syslog', label: 'Syslog' },
  { id: 'regex', label: 'Regex' },
];

export function presetFromState(state: MultilineState): MultilinePreset {
  if (!state.sessionOptionsMultilineEnabled) return 'off';
  if (state.sessionOptionsMultilineMode === 'indent') return 'indent';
  if (state.sessionOptionsMultilineHeaderPattern === ISO8601_HEADER_PATTERN) return 'iso8601';
  if (state.sessionOptionsMultilineHeaderPattern === SYSLOG_HEADER_PATTERN) return 'syslog';
  return 'regex';
}

// The store triple a preset maps onto. `regex` keeps whatever custom
// header pattern is already there (so switching away and back doesn't
// lose the user's regex) unless that pattern is one of the presets.
export function stateFromPreset(preset: MultilinePreset, current: MultilineState): MultilineState {
  switch (preset) {
    case 'off':
      return { ...current, sessionOptionsMultilineEnabled: false };
    case 'indent':
      return {
        sessionOptionsMultilineEnabled: true,
        sessionOptionsMultilineMode: 'indent',
        sessionOptionsMultilineHeaderPattern: '',
      };
    case 'iso8601':
      return {
        sessionOptionsMultilineEnabled: true,
        sessionOptionsMultilineMode: 'header',
        sessionOptionsMultilineHeaderPattern: ISO8601_HEADER_PATTERN,
      };
    case 'syslog':
      return {
        sessionOptionsMultilineEnabled: true,
        sessionOptionsMultilineMode: 'header',
        sessionOptionsMultilineHeaderPattern: SYSLOG_HEADER_PATTERN,
      };
    case 'regex': {
      const keep =
        current.sessionOptionsMultilineMode === 'header' &&
        current.sessionOptionsMultilineHeaderPattern !== ISO8601_HEADER_PATTERN &&
        current.sessionOptionsMultilineHeaderPattern !== SYSLOG_HEADER_PATTERN
          ? current.sessionOptionsMultilineHeaderPattern
          : '';
      return {
        sessionOptionsMultilineEnabled: true,
        sessionOptionsMultilineMode: 'header',
        sessionOptionsMultilineHeaderPattern: keep,
      };
    }
  }
}
