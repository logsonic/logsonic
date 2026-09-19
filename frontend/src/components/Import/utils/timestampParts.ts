import type { TimestampInference, TimestampResolution } from '@/lib/api-types';

// Pure helpers behind the Timestamp tab: split a resolved timestamp into
// its parts and derive, for each part, whether it was read from the log
// or filled in (and by what). Moved verbatim from the old
// TimestampBuilder so the provenance rules stay identical; the tab only
// changes how they are drawn.

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export type Comp = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'ms' | 'tz';

export interface Parts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  ms: string;
  offset: string; // raw offset token from the resolved string ("Z", "+05:30", …)
}

// Effective resolution = inferred defaults overlaid with user overrides.
export function effectiveResolution(
  inf: TimestampInference | null,
  overrides: Partial<TimestampResolution>
): TimestampResolution | null {
  if (!inf) return null;
  return {
    ...inf.resolution,
    ...overrides,
    anchor: overrides.anchor ?? inf.resolution.anchor,
    timezone: overrides.timezone ?? inf.resolution.timezone,
  };
}

// Parse an RFC3339-ish resolved string into wall-clock components, WITHOUT
// converting to local time (we want to show exactly what the resolver emitted).
export function parseResolved(s?: string): Parts | null {
  if (!s) return null;
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/
  );
  if (!m) return null;
  const frac = (m[7] || '').slice(0, 3).padEnd(3, '0');
  return {
    year: m[1],
    month: m[2],
    day: m[3],
    hour: m[4],
    minute: m[5],
    second: m[6],
    ms: frac,
    offset: m[8] || '',
  };
}

// A readable zone label from a raw offset token.
export function zoneLabel(offset: string): string {
  if (!offset || offset === 'Z' || offset === '+00:00' || offset === '+0000') return 'UTC';
  return offset;
}

// Where a part's value came from. `filled` means the resolver (or the
// user) supplied it rather than the log line; `src` is the short label.
export interface PartState {
  value: string;
  filled: boolean;
  src: string;
}

const TZ_MARKER =
  /(\bZ\b|[+-]\d{2}:?\d{2}|\b(UTC|GMT|PST|PDT|EST|EDT|CST|CDT|MST|MDT|BST|JST|IST|KST|CET|CEST|EET|EEST|WET|WEST|AST|ADT|HST|NZST|NZDT|AEST|AEDT|ACST|ACDT|AWST)\b|[A-Z][A-Za-z_]+\/[A-Za-z_]+)/;

export function buildState(
  inf: TimestampInference,
  eff: TimestampResolution,
  p: Parts | null
): Record<Comp, PartState> {
  // An "exact" resolution means the chosen source carried a complete
  // timestamp, so every component was read — only explicit forces count as
  // filled. The per-row confidence is the live signal (the overall status
  // reflects the original canonical scan, not a source-field override).
  const exact = inf.preview?.[0]?.confidence === 'exact';
  const yearForced = eff.year_strategy === 'forced';
  const yearFilled =
    yearForced || (!exact && (eff.year_strategy === 'from_anchor' || inf.layout.year_width === 0));
  const yearSrc = yearForced
    ? 'fixed'
    : eff.year_strategy === 'from_anchor' && !exact
      ? eff.anchor.kind === 'now'
        ? 'this year'
        : 'file date'
      : 'read';

  const monthFilled = eff.forced_month != null;
  const dayFilled = eff.forced_day != null;
  const tzForced = eff.timezone.kind === 'forced';
  // The captured time carried no offset → resolver defaults to UTC; that's
  // a fill, not a read. Detection has to look at the *raw* captured string
  // — the resolved output always normalizes to UTC (Z), so the parsed offset
  // is useless here. We scan the input field that the resolver actually used.
  const cap = inf.preview?.[0]?.captured || {};
  const capturedTime =
    (eff.source_field && cap[eff.source_field]) ||
    cap.timestamp ||
    cap.time ||
    cap.ts ||
    cap.date ||
    cap.datetime ||
    (Object.keys(cap).length === 1 ? (Object.values(cap)[0] as string) : '');
  const capturedHadTz = !!capturedTime && TZ_MARKER.test(capturedTime);
  const tzDefaulted = !tzForced && !capturedHadTz;
  const tzFilled = tzForced || tzDefaulted;
  // No sub-second in the log → resolver emits .000; treat an all-zero
  // fraction as "filled" (defaulted) only when the time wasn't an exact parse.
  const msFilled = !exact && (!p || p.ms === '000');

  const v = (k: keyof Parts) => (p ? (p[k] as string) : '');
  return {
    year: {
      value: v('year') || (eff.forced_year ? String(eff.forced_year) : '—'),
      filled: yearFilled,
      src: yearSrc,
    },
    month: { value: v('month') || '—', filled: monthFilled, src: monthFilled ? 'fixed' : 'read' },
    day: { value: v('day') || '—', filled: dayFilled, src: dayFilled ? 'fixed' : 'read' },
    hour: { value: v('hour') || '—', filled: false, src: 'read' },
    minute: { value: v('minute') || '—', filled: false, src: 'read' },
    second: { value: v('second') || '—', filled: false, src: 'read' },
    ms: { value: v('ms') || '000', filled: msFilled, src: msFilled ? 'default' : 'read' },
    tz: {
      value: tzForced ? eff.timezone.value || 'UTC' : zoneLabel(p?.offset || ''),
      filled: tzFilled,
      src: tzForced ? 'forced' : tzDefaulted ? 'default' : 'as captured',
    },
  };
}

// ---- Override picker payloads. Identical to the patches the old
// YearPop / MonthPop / DayPop / TzPop applied, so the backend sees the
// same TimestampResolution shapes as before. -------------------------------

export type YearChoice = 'parsed' | 'file_mtime' | 'now' | 'previous' | 'custom';

export function yearPatch(
  choice: YearChoice,
  ctx: { mtimeYear: number | null; nowYear: number; custom?: number }
): Partial<TimestampResolution> | null {
  switch (choice) {
    case 'parsed':
      return { year_strategy: 'parsed', forced_year: undefined };
    case 'file_mtime':
      if (ctx.mtimeYear == null) return null;
      return { year_strategy: 'forced', forced_year: ctx.mtimeYear, force_mode: 'overwrite' };
    case 'now':
      return { year_strategy: 'forced', forced_year: ctx.nowYear, force_mode: 'overwrite' };
    case 'previous':
      return { year_strategy: 'forced', forced_year: ctx.nowYear - 1, force_mode: 'overwrite' };
    case 'custom':
      if (
        ctx.custom == null ||
        !Number.isFinite(ctx.custom) ||
        ctx.custom < 1 ||
        ctx.custom > 9999
      ) {
        return null;
      }
      return { year_strategy: 'forced', forced_year: ctx.custom, force_mode: 'overwrite' };
  }
}

// Which year choice the effective resolution currently corresponds to,
// so the picker can mark it selected.
export function currentYearChoice(
  eff: TimestampResolution,
  ctx: { mtimeYear: number | null; nowYear: number }
): YearChoice {
  if (eff.year_strategy === 'parsed') return 'parsed';
  if (eff.year_strategy === 'forced' && eff.forced_year != null) {
    if (eff.forced_year === ctx.mtimeYear) return 'file_mtime';
    if (eff.forced_year === ctx.nowYear) return 'now';
    if (eff.forced_year === ctx.nowYear - 1) return 'previous';
    return 'custom';
  }
  if (eff.year_strategy === 'from_anchor') {
    return eff.anchor.kind === 'file_mtime' ? 'file_mtime' : 'now';
  }
  return 'parsed';
}

export function monthPatch(month: number | null): Partial<TimestampResolution> {
  return month == null
    ? { forced_month: undefined }
    : { forced_month: month, force_mode: 'overwrite' };
}

export function dayPatch(day: number | null): Partial<TimestampResolution> {
  return day == null ? { forced_day: undefined } : { forced_day: day, force_mode: 'overwrite' };
}

export function timezonePatch(tz: string | null): Partial<TimestampResolution> {
  return tz == null
    ? { timezone: { kind: 'as_parsed' } }
    : { timezone: { kind: 'forced', value: tz } };
}

// Overrides the user has actually set (keys present in the per-file
// override map), for the "N manual overrides" strip.
export function describeOverrides(overrides: Partial<TimestampResolution>): string[] {
  const out: string[] = [];
  if (overrides.year_strategy === 'forced' && overrides.forced_year != null) {
    out.push(`year → ${overrides.forced_year}`);
  } else if (overrides.year_strategy === 'parsed') {
    out.push('year → from log');
  }
  if (overrides.forced_month != null) out.push(`month → ${MONTHS[overrides.forced_month - 1]}`);
  if (overrides.forced_day != null) out.push(`day → ${overrides.forced_day}`);
  if (overrides.timezone?.kind === 'forced') out.push(`tz → ${overrides.timezone.value}`);
  else if (overrides.timezone?.kind === 'as_parsed') out.push('tz → as captured');
  if (overrides.source_field) out.push(`source → ${overrides.source_field}`);
  return out;
}
