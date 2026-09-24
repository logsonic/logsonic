import { describe, expect, it } from 'vitest';

import { DEFAULT_MULTILINE } from '../../types';
import {
  isHeaderPatternMissing,
  ISO8601_HEADER_PATTERN,
  multilineConfigOf,
  multilineFromConfig,
  multilineLabel,
  presetFromState,
  stateFromPreset,
} from '../multilinePresets';

describe('multilinePresets', () => {
  it('round-trips every preset through the per-file state', () => {
    for (const id of ['off', 'indent', 'iso8601', 'syslog', 'regex'] as const) {
      expect(presetFromState(stateFromPreset(id, DEFAULT_MULTILINE))).toBe(id);
    }
  });

  it('regex keeps a custom header pattern but not a preset one', () => {
    const custom = { enabled: true, mode: 'header' as const, headerPattern: '^x' };
    expect(stateFromPreset('regex', custom).headerPattern).toBe('^x');
    const iso = stateFromPreset('iso8601', DEFAULT_MULTILINE);
    expect(stateFromPreset('regex', iso).headerPattern).toBe('');
  });

  it('maps to the API config, sending off explicitly', () => {
    expect(multilineConfigOf(DEFAULT_MULTILINE)).toEqual({ enabled: false, mode: 'header' });
    expect(multilineConfigOf(stateFromPreset('iso8601', DEFAULT_MULTILINE))).toEqual({
      enabled: true,
      mode: 'header',
      header_pattern: ISO8601_HEADER_PATTERN,
    });
    expect(multilineConfigOf(stateFromPreset('indent', DEFAULT_MULTILINE))).toEqual({
      enabled: true,
      mode: 'indent',
      header_pattern: undefined,
    });
  });

  it('reads a suggester config back into per-file state', () => {
    expect(multilineFromConfig(undefined)).toBeNull();
    expect(multilineFromConfig({ enabled: false, mode: 'header' })).toBeNull();
    expect(
      multilineFromConfig({ enabled: true, mode: 'header', header_pattern: ISO8601_HEADER_PATTERN })
    ).toEqual({ enabled: true, mode: 'header', headerPattern: ISO8601_HEADER_PATTERN });
  });

  it('flags header mode with a blank pattern', () => {
    expect(isHeaderPatternMissing({ enabled: true, mode: 'header', headerPattern: '  ' })).toBe(
      true
    );
    expect(isHeaderPatternMissing({ enabled: true, mode: 'indent', headerPattern: '' })).toBe(
      false
    );
    expect(isHeaderPatternMissing(DEFAULT_MULTILINE)).toBe(false);
  });

  it('labels the folding for the rail', () => {
    expect(multilineLabel(DEFAULT_MULTILINE)).toBeNull();
    expect(multilineLabel(stateFromPreset('iso8601', DEFAULT_MULTILINE))).toBe('ISO8601');
    expect(multilineLabel({ enabled: true, mode: 'header', headerPattern: '^x' })).toBe('regex');
  });
});
