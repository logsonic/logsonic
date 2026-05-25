import { TimezoneSelectorCommon } from '@/components/common/TimezoneSelectorCommon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FieldCandidate, TimestampInference, TimestampResolution } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import { Check, FileClock, Info, Pencil, RotateCcw } from 'lucide-react';
import { FC, ReactNode, useState } from 'react';

// ---------------------------------------------------------------------------
// TimestampBuilder — the part-by-part replacement for the old "Knobs" drawer.
//
// It breaks the resolved timestamp into editable tiles (year / month / day /
// hour / minute / second / millisecond / timezone) grouped into Date · Time ·
// Timezone clusters. Two independent colour axes:
//   • group hue (blue / violet / cyan) says WHERE in the timestamp a tile sits
//   • provenance (emerald = read from the log, amber = we filled it in) says
//     where the value came from.
//
// Every tile maps onto a field of the unchanged `TimestampResolution` struct —
// no "anchor" / "year strategy" / "force mode" vocabulary reaches the user.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Comp = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'ms' | 'tz';

interface Parts {
  year: string; month: string; day: string;
  hour: string; minute: string; second: string; ms: string;
  offset: string; // raw offset token from the resolved string ("Z", "+05:30", …)
}

// Parse an RFC3339-ish resolved string into wall-clock components, WITHOUT
// converting to local time (we want to show exactly what the resolver emitted).
function parseResolved(s?: string): Parts | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const frac = (m[7] || '').slice(0, 3).padEnd(3, '0');
  return {
    year: m[1], month: m[2], day: m[3],
    hour: m[4], minute: m[5], second: m[6], ms: frac,
    offset: m[8] || '',
  };
}

// A readable zone label from a raw offset token.
function zoneLabel(offset: string): string {
  if (!offset || offset === 'Z' || offset === '+00:00' || offset === '+0000') return 'UTC';
  return offset;
}

// ---- provenance: derive read vs filled for each component from the
// effective resolution + what the log layout actually carried. -------------
interface PartState { value: string; filled: boolean; src: string }

function buildState(inf: TimestampInference, eff: TimestampResolution, p: Parts | null): Record<Comp, PartState> {
  // An "exact" resolution means the chosen source carried a complete
  // timestamp, so every component was read — only explicit forces count as
  // filled. The per-row confidence is the live signal (the overall status
  // reflects the original canonical scan, not a source-field override).
  const exact = inf.preview?.[0]?.confidence === 'exact';
  const yearForced = eff.year_strategy === 'forced';
  const yearFilled = yearForced || (!exact && (eff.year_strategy === 'from_anchor' || inf.layout.year_width === 0));
  const yearSrc =
    yearForced ? 'fixed'
    : (eff.year_strategy === 'from_anchor' && !exact) ? (eff.anchor.kind === 'now' ? 'this year' : 'file date')
    : 'read';

  const monthFilled = eff.forced_month != null;
  const dayFilled = eff.forced_day != null;
  const tzForced = eff.timezone.kind === 'forced';
  // The captured time carried no offset → resolver defaults to UTC; that's
  // a fill, not a read. Detection has to look at the *raw* captured string
  // — the resolved output always normalizes to UTC (Z), so the parsed offset
  // is useless here. We scan the input field that the resolver actually used.
  const cap = inf.preview?.[0]?.captured || {};
  const capturedTime = (eff.source_field && cap[eff.source_field])
    || cap.timestamp || cap.time || cap.ts || cap.date || cap.datetime
    || (Object.keys(cap).length === 1 ? Object.values(cap)[0] as string : '');
  const TZ_MARKER = /(\bZ\b|[+-]\d{2}:?\d{2}|\b(UTC|GMT|PST|PDT|EST|EDT|CST|CDT|MST|MDT|BST|JST|IST|KST|CET|CEST|EET|EEST|WET|WEST|AST|ADT|HST|NZST|NZDT|AEST|AEDT|ACST|ACDT|AWST)\b|[A-Z][A-Za-z_]+\/[A-Za-z_]+)/;
  const capturedHadTz = !!capturedTime && TZ_MARKER.test(capturedTime);
  const tzDefaulted = !tzForced && !capturedHadTz;
  const tzFilled = tzForced || tzDefaulted;
  // No sub-second in the log → resolver emits .000; treat an all-zero
  // fraction as "filled" (defaulted) only when the time wasn't an exact parse.
  const msFilled = !exact && (!p || p.ms === '000');

  const v = (k: keyof Parts) => (p ? (p[k] as string) : '');
  return {
    year:   { value: v('year') || (eff.forced_year ? String(eff.forced_year) : '—'), filled: yearFilled, src: yearSrc },
    month:  { value: v('month') || '—', filled: monthFilled, src: monthFilled ? 'fixed' : 'read' },
    day:    { value: v('day') || '—',   filled: dayFilled,   src: dayFilled ? 'fixed' : 'read' },
    hour:   { value: v('hour') || '—',  filled: false, src: 'read' },
    minute: { value: v('minute') || '—', filled: false, src: 'read' },
    second: { value: v('second') || '—', filled: false, src: 'read' },
    ms:     { value: v('ms') || '000',  filled: msFilled, src: msFilled ? 'default' : 'read' },
    tz:     {
      value: tzForced ? (eff.timezone.value || 'UTC') : zoneLabel(p?.offset || ''),
      filled: tzFilled,
      src: tzForced ? 'forced' : tzDefaulted ? 'default' : 'as captured',
    },
  };
}

// ---- group styling -------------------------------------------------------
const GROUPS: Record<'date' | 'time' | 'tz', { label: string; box: string; text: string; sep: string }> = {
  date: { label: 'Date',     box: 'border-blue-200/80 bg-blue-50/50',     text: 'text-blue-700',   sep: 'text-blue-300' },
  time: { label: 'Time',     box: 'border-violet-200/80 bg-violet-50/50', text: 'text-violet-700', sep: 'text-violet-300' },
  tz:   { label: 'Timezone', box: 'border-cyan-200/80 bg-cyan-50/50',     text: 'text-cyan-700',   sep: 'text-cyan-300' },
};

const LABELS: Record<Comp, string> = {
  year: 'Year', month: 'Month', day: 'Day', hour: 'Hour',
  minute: 'Min', second: 'Sec', ms: 'Millisec', tz: 'Zone',
};

// ---- a single editable tile ----------------------------------------------
// `valueClass` lets text-heavy tiles (the timezone, which can hold a long IANA
// name like "America/Argentina/Buenos_Aires") use a smaller, non-wrapping font.
const Tile: FC<{
  st: PartState;
  label: string;
  interactive: boolean;
  popover?: (close: () => void) => ReactNode;
  wide?: boolean;
  valueClass?: string;
  maxWidth?: string;
}> = ({ st, label, interactive, popover, wide, valueClass, maxWidth }) => {
  const [open, setOpen] = useState(false);
  const inner = (
    <div
      className={cn(
        'relative flex flex-col items-center gap-1.5 rounded-[11px] border bg-white px-3 pt-2.5 pb-3 transition-all',
        wide ? 'min-w-[58px]' : 'min-w-[50px]',
        maxWidth && 'min-w-0',
        interactive
          ? 'cursor-pointer border-slate-200 hover:-translate-y-px hover:border-violet-300 hover:shadow-[0_8px_18px_-12px_rgba(124,58,237,0.55)]'
          : 'border-slate-200 cursor-default',
        maxWidth ? maxWidth : '',
      )}
      title={`${st.value} — ${st.filled ? 'filled in' : 'read from the log'} (${st.src})${interactive ? ' · click to change' : ''}`}
    >
      <span className={cn('truncate font-mono font-bold leading-none', valueClass || 'text-[17px]', st.filled ? 'text-amber-600' : 'text-emerald-700')}>
        {st.value}
      </span>
      <span className="text-[8.5px] font-bold uppercase leading-none tracking-wider text-slate-400">{label}</span>
      {interactive && <Pencil className="absolute right-1 top-1 h-2.5 w-2.5 text-slate-300" />}
    </div>
  );
  if (!interactive || !popover) return inner;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="appearance-none border-0 bg-transparent p-0">{inner}</button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-[290px] p-3.5">{popover(() => setOpen(false))}</PopoverContent>
    </Popover>
  );
};

const Sep: FC<{ ch: string; tone: string }> = ({ ch, tone }) => (
  <span className={cn('select-none self-start pt-[15px] font-mono text-[18px] font-semibold opacity-50', tone)}>{ch}</span>
);

// ---- popover building blocks ---------------------------------------------
const PopHead: FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <>
    <h4 className="text-[13.5px] font-bold text-slate-800">{title}</h4>
    <p className="mb-2 text-[11.5px] text-muted-foreground">{sub}</p>
  </>
);
const PopGroup: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="mb-1.5 mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{children}</div>
);
// Radio-style option used in tile popovers — just updates pending state,
// doesn't commit. A single Apply button at the bottom of each popover
// commits the selection.
const Radio: FC<{ checked: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; sm?: ReactNode }>
  = ({ checked, disabled, onClick, children, sm }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={cn(
      'mb-1.5 flex w-full items-center gap-2.5 rounded-[9px] border px-2.5 py-2 text-left text-[13px] transition-colors',
      disabled ? 'cursor-default opacity-55' : 'cursor-pointer hover:border-slate-300 hover:bg-slate-50',
      checked ? 'border-violet-400 bg-violet-50' : 'border-slate-200',
    )}
  >
    <span className={cn('relative h-[15px] w-[15px] flex-shrink-0 rounded-full border-2',
      checked ? 'border-violet-500' : 'border-slate-300')}>
      {checked && <span className="absolute inset-[3px] rounded-full bg-violet-500" />}
    </span>
    <span className={cn('flex-1 truncate', checked ? 'font-semibold text-violet-800' : 'text-slate-700')}>{children}</span>
    {sm && <span className={cn('font-mono text-[11.5px]', checked ? 'text-violet-600' : 'text-muted-foreground')}>{sm}</span>}
  </button>
);

const PopActions: FC<{ onCancel: () => void; onApply: () => void; applyDisabled?: boolean }>
  = ({ onCancel, onApply, applyDisabled }) => (
  <div className="mt-3 flex justify-end gap-1.5 border-t border-slate-200 pt-3">
    <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="h-8">Cancel</Button>
    <Button type="button" size="sm" onClick={onApply} disabled={applyDisabled} className="h-8">Apply</Button>
  </div>
);

// ---- popovers (radio + Apply) -------------------------------------------
type Patch = (p: Partial<TimestampResolution>) => void;
type YearMode = 'parsed' | 'file_mtime' | 'now' | 'forced';

const YearPop: FC<{
  eff: TimestampResolution;
  yearFromLog: boolean;
  sourceMTime: string | null;
  patch: Patch;
  close: () => void;
}> = ({ eff, yearFromLog, sourceMTime, patch, close }) => {
  const mtimeYearN = sourceMTime ? new Date(sourceMTime).getFullYear() : null;
  const nowYearN = new Date().getFullYear();
  // "From file date" and "This year" patch as `forced` with the literal year,
  // bypassing the resolver's future-clamp. So determine which radio is active
  // by matching forced_year against those reference values.
  const initial: YearMode =
    eff.year_strategy === 'parsed' ? 'parsed'
    : eff.year_strategy === 'forced' && eff.forced_year != null && eff.forced_year === mtimeYearN ? 'file_mtime'
    : eff.year_strategy === 'forced' && eff.forced_year != null && eff.forced_year === nowYearN ? 'now'
    : eff.year_strategy === 'forced' ? 'forced'
    : eff.year_strategy === 'from_anchor' && eff.anchor.kind === 'file_mtime' ? 'file_mtime'
    : eff.year_strategy === 'from_anchor' && eff.anchor.kind === 'now' ? 'now'
    : 'parsed';
  const [mode, setMode] = useState<YearMode>(initial);
  const [forcedYear, setForcedYear] = useState(
    eff.year_strategy === 'forced' && eff.forced_year != null && eff.forced_year !== mtimeYearN && eff.forced_year !== nowYearN
      ? String(eff.forced_year)
      : ''
  );

  const fileMtimeChip = mtimeYearN != null ? String(mtimeYearN) : '—';
  const nowChip = String(nowYearN);

  const yearParsed = parseInt(forcedYear, 10);
  const customValid = Number.isFinite(yearParsed) && yearParsed >= 1 && yearParsed <= 9999;
  const applyDisabled = mode === 'forced' && !customValid;

  const apply = () => {
    switch (mode) {
      case 'parsed':
        patch({ year_strategy: 'parsed', forced_year: undefined });
        break;
      case 'file_mtime':
        if (mtimeYearN == null) return;
        patch({ year_strategy: 'forced', forced_year: mtimeYearN, force_mode: 'overwrite' });
        break;
      case 'now':
        patch({ year_strategy: 'forced', forced_year: nowYearN, force_mode: 'overwrite' });
        break;
      case 'forced':
        if (!customValid) return;
        patch({ year_strategy: 'forced', forced_year: yearParsed, force_mode: 'overwrite' });
        break;
    }
    close();
  };

  return (
    <div>
      <PopHead title="Year" sub="Where should the year come from?" />
      <PopGroup>Read from the log</PopGroup>
      <Radio disabled={!yearFromLog} checked={mode === 'parsed'} onClick={() => yearFromLog && setMode('parsed')}>
        {yearFromLog ? 'Use the year in the log' : 'This log has no year'}
      </Radio>
      <PopGroup>Or set a fixed value</PopGroup>
      <Radio disabled={!sourceMTime} checked={mode === 'file_mtime'} sm={fileMtimeChip}
        onClick={() => sourceMTime && setMode('file_mtime')}>
        <span className="inline-flex items-center gap-1.5"><FileClock className="h-3.5 w-3.5" /> From file date</span>
      </Radio>
      <Radio checked={mode === 'now'} sm={nowChip} onClick={() => setMode('now')}>This year</Radio>
      <div className={cn(
        'mb-1.5 flex w-full items-center gap-2.5 rounded-[9px] border px-2.5 py-2 transition-colors',
        mode === 'forced' ? 'border-violet-400 bg-violet-50' : 'border-slate-200',
      )}>
        <button type="button" onClick={() => setMode('forced')}
          className={cn('relative h-[15px] w-[15px] flex-shrink-0 rounded-full border-2',
            mode === 'forced' ? 'border-violet-500' : 'border-slate-300')}>
          {mode === 'forced' && <span className="absolute inset-[3px] rounded-full bg-violet-500" />}
        </button>
        <span className={cn('text-[13px]', mode === 'forced' ? 'font-semibold text-violet-800' : 'text-slate-700')}>Custom</span>
        <Input value={forcedYear}
          onChange={(e) => { setForcedYear(e.target.value); setMode('forced'); }}
          onFocus={() => setMode('forced')}
          placeholder="YYYY"
          className="ml-auto h-8 w-[88px] font-mono text-[13px]" />
      </div>
      <PopActions onCancel={close} onApply={apply} applyDisabled={applyDisabled} />
    </div>
  );
};

type MonthMode = 'parsed' | 'forced';
const MonthPop: FC<{ eff: TimestampResolution; patch: Patch; close: () => void }>
  = ({ eff, patch, close }) => {
  const [mode, setMode] = useState<MonthMode>(eff.forced_month != null ? 'forced' : 'parsed');
  const [month, setMonth] = useState<number | null>(eff.forced_month ?? null);
  const applyDisabled = mode === 'forced' && month == null;
  const apply = () => {
    if (mode === 'parsed') patch({ forced_month: undefined });
    else if (month != null) patch({ forced_month: month, force_mode: 'overwrite' });
    close();
  };
  return (
    <div>
      <PopHead title="Month" sub="Where should the month come from?" />
      <PopGroup>Read from the log</PopGroup>
      <Radio checked={mode === 'parsed'} onClick={() => setMode('parsed')}>Use the month in the log</Radio>
      <PopGroup>Or pick a fixed month</PopGroup>
      <div className={cn('rounded-[9px] border p-2 transition-colors',
        mode === 'forced' ? 'border-violet-400 bg-violet-50' : 'border-slate-200')}>
        <div className="grid grid-cols-4 gap-1.5">
          {MONTHS.map((m, i) => (
            <button key={m} type="button"
              onClick={() => { setMonth(i + 1); setMode('forced'); }}
              className={cn('rounded-md border py-1.5 text-[12px] font-medium transition-colors',
                mode === 'forced' && month === i + 1
                  ? 'border-violet-500 bg-white text-violet-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <PopActions onCancel={close} onApply={apply} applyDisabled={applyDisabled} />
    </div>
  );
};

type DayMode = 'parsed' | 'forced';
const DayPop: FC<{ eff: TimestampResolution; patch: Patch; close: () => void }>
  = ({ eff, patch, close }) => {
  const [mode, setMode] = useState<DayMode>(eff.forced_day != null ? 'forced' : 'parsed');
  const [day, setDay] = useState(eff.forced_day ? String(eff.forced_day) : '');
  const dayParsed = parseInt(day, 10);
  const customValid = Number.isFinite(dayParsed) && dayParsed >= 1 && dayParsed <= 31;
  const applyDisabled = mode === 'forced' && !customValid;
  const apply = () => {
    if (mode === 'parsed') patch({ forced_day: undefined });
    else if (customValid) patch({ forced_day: dayParsed, force_mode: 'overwrite' });
    close();
  };
  return (
    <div>
      <PopHead title="Day" sub="Where should the day come from?" />
      <PopGroup>Read from the log</PopGroup>
      <Radio checked={mode === 'parsed'} onClick={() => setMode('parsed')}>Use the day in the log</Radio>
      <PopGroup>Or set a fixed value</PopGroup>
      <div className={cn(
        'mb-1.5 flex w-full items-center gap-2.5 rounded-[9px] border px-2.5 py-2 transition-colors',
        mode === 'forced' ? 'border-violet-400 bg-violet-50' : 'border-slate-200',
      )}>
        <button type="button" onClick={() => setMode('forced')}
          className={cn('relative h-[15px] w-[15px] flex-shrink-0 rounded-full border-2',
            mode === 'forced' ? 'border-violet-500' : 'border-slate-300')}>
          {mode === 'forced' && <span className="absolute inset-[3px] rounded-full bg-violet-500" />}
        </button>
        <span className={cn('text-[13px]', mode === 'forced' ? 'font-semibold text-violet-800' : 'text-slate-700')}>Custom</span>
        <Input value={day}
          onChange={(e) => { setDay(e.target.value); setMode('forced'); }}
          onFocus={() => setMode('forced')}
          placeholder="DD"
          className="ml-auto h-8 w-[72px] font-mono text-[13px]" />
      </div>
      <PopActions onCancel={close} onApply={apply} applyDisabled={applyDisabled} />
    </div>
  );
};

type TzMode = 'as_parsed' | 'forced';
const TzPop: FC<{ eff: TimestampResolution; patch: Patch; close: () => void }>
  = ({ eff, patch, close }) => {
  const [mode, setMode] = useState<TzMode>(eff.timezone.kind === 'forced' ? 'forced' : 'as_parsed');
  const [tz, setTz] = useState(eff.timezone.value || 'UTC');
  const apply = () => {
    if (mode === 'as_parsed') patch({ timezone: { kind: 'as_parsed' } });
    else patch({ timezone: { kind: 'forced', value: tz } });
    close();
  };
  return (
    <div>
      <PopHead title="Timezone" sub="What zone are these times in?" />
      <PopGroup>Read from the log</PopGroup>
      <Radio checked={mode === 'as_parsed'} onClick={() => setMode('as_parsed')}>
        As captured <span className="text-muted-foreground">(default UTC)</span>
      </Radio>
      <PopGroup>Or force a timezone</PopGroup>
      <div className={cn('rounded-[9px] border p-2 transition-colors',
        mode === 'forced' ? 'border-violet-400 bg-violet-50' : 'border-slate-200')}>
        <TimezoneSelectorCommon
          selectedTimezone={tz}
          onTimezoneChange={(v) => { setTz(v); setMode('forced'); }}
          label=""
          placeholder="Pick a timezone"
        />
      </div>
      <PopActions onCancel={close} onApply={apply} />
    </div>
  );
};

// ---------------------------------------------------------------------------
interface BuilderProps {
  inference: TimestampInference;
  eff: TimestampResolution;
  patch: (p: Partial<TimestampResolution>) => void;
  reset: () => void;
  hasOverrides: boolean;
  sourceMTime: string | null;
}

export const TimestampBuilder: FC<BuilderProps> = ({ inference, eff, patch, reset, hasOverrides, sourceMTime }) => {
  const parts = parseResolved(inference.preview?.[0]?.resolved);
  const st = buildState(inference, eff, parts);
  const yearFromLog = inference.layout.year_width > 0;

  // Source candidates that parse as a timestamp — the "which column is the
  // time" decision. Surfaced only when there's a real choice to make.
  const tsCandidates: FieldCandidate[] = (inference.field_candidates || []).filter(c => c.parses);
  // Surface the source switch when there's a real choice: several fields parse
  // as a timestamp, a source is already pinned, or the auto-detected time
  // actually failed (synthetic/missing) while some other field parses — the
  // "two timestamps, the obvious one didn't parse" case. We deliberately do
  // NOT show it for a merely "inferred" time (e.g. a borrowed year), so a
  // stray field that happens to look epoch-ish (a PID, a port) stays hidden.
  const autoFailed = inference.preview?.[0]?.confidence === 'synthetic' || inference.status === 'missing' || inference.status === 'ambiguous';
  const showSource = tsCandidates.length >= 2 || !!eff.source_field || (tsCandidates.length >= 1 && autoFailed);
  const currentSource = eff.source_field || '';

  const pickSource = (c: FieldCandidate | null) => {
    if (!c) patch({ source_field: '', source_format: '' });
    else patch({ source_field: c.name, source_format: c.format && c.format !== 'auto' ? c.format : '' });
  };

  // For the file_mtime / now options, prefer the year actually being applied
  // (the resolver may roll back a year to avoid future-dating, so the raw
  // mtime year can disagree with the tile). When that anchor is currently
  // selected, the tile already reflects what's applied — show it. Otherwise
  // fall back to the raw anchor year as a preview.

  // ---- consolidated fill note ----
  const filledParts = (['year', 'month', 'day', 'second', 'ms', 'tz'] as Comp[]).filter(c => st[c].filled);
  const human: Record<Comp, string> = { year: 'year', month: 'month', day: 'day', hour: 'hour', minute: 'minute', second: 'second', ms: 'millisecond', tz: 'timezone' };
  // join React nodes with ", " and a trailing " and "
  const joinNodes = (nodes: ReactNode[]): ReactNode[] =>
    nodes.flatMap((n, i) => i === 0 ? [n] : [i === nodes.length - 1 ? ' and ' : ', ', n]);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <Info className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 text-amber-500" />
        <p className="flex-1 text-[13px] text-slate-700">
          <span className="font-semibold">Here's how we read the time.</span>
          <span className="block text-[12.5px] text-muted-foreground">
            Each part is set once and applies to every line. Click any part to change where its value comes from.
          </span>
        </p>
        {hasOverrides && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reset}
            className="h-7 gap-1.5 text-[12px] text-slate-600 hover:text-slate-800"
            title="Discard your overrides and use the auto-detected values"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to auto
          </Button>
        )}
      </div>

      {/* Source switch — "which column is the time" */}
      {showSource && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-3">
          <span className="mr-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Time source</span>
          <SourceOpt label="Auto-detect" sub="canonical scan" selected={!currentSource} onClick={() => pickSource(null)} />
          {tsCandidates.map(c => (
            <SourceOpt key={c.name} label={c.name} sub={c.sample} selected={currentSource === c.name} onClick={() => pickSource(c)} />
          ))}
        </div>
      )}

      {/* the editable timestamp */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-4 px-0.5 pt-0.5">
        {/* DATE */}
        <Group g="date">
          <Tile st={st.year} label={LABELS.year} interactive wide
            popover={(close) => (
              <YearPop eff={eff} yearFromLog={yearFromLog} sourceMTime={sourceMTime}
                patch={patch} close={close} />
            )} />
          <Sep ch="-" tone={GROUPS.date.sep} />
          <Tile st={st.month} label={LABELS.month} interactive
            popover={(close) => <MonthPop eff={eff} patch={patch} close={close} />} />
          <Sep ch="-" tone={GROUPS.date.sep} />
          <Tile st={st.day} label={LABELS.day} interactive
            popover={(close) => <DayPop eff={eff} patch={patch} close={close} />} />
        </Group>
        {/* TIME */}
        <Group g="time">
          <Tile st={st.hour} label={LABELS.hour} interactive={false} />
          <Sep ch=":" tone={GROUPS.time.sep} />
          <Tile st={st.minute} label={LABELS.minute} interactive={false} />
          <Sep ch=":" tone={GROUPS.time.sep} />
          <Tile st={st.second} label={LABELS.second} interactive={false} />
          <Sep ch="." tone={GROUPS.time.sep} />
          <Tile st={st.ms} label={LABELS.ms} interactive={false} wide />
        </Group>
        {/* TIMEZONE */}
        <div className="ml-auto flex-shrink min-w-0">
          <Group g="tz">
            <Tile st={st.tz} label={LABELS.tz} interactive wide={false}
              popover={(close) => <TzPop eff={eff} patch={patch} close={close} />}
              valueClass="text-[11px]" maxWidth="max-w-[120px]" />
          </Group>
        </div>
      </div>

      {/* consolidated fill note */}
      {filledParts.length > 0 ? (
        <div className="flex items-start gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] leading-snug text-slate-700">
          <Info className="mt-px h-4 w-4 flex-shrink-0 text-amber-500" />
          <span>
            The log didn't include the{' '}
            {joinNodes(filledParts.map(c => <b key={c} className="font-semibold text-slate-900">{human[c]}</b>))}
            , so we filled {filledParts.length === 1 ? 'it' : 'them'} in:{' '}
            {joinNodes(filledParts.map(c => (
              <span key={c}><b className="font-semibold text-slate-900">{human[c]}</b> {st[c].value} ({st[c].src})</span>
            )))}. Click any amber tile to change it.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-[10px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12.5px] leading-snug text-emerald-800">
          <Check className="mt-px h-4 w-4 flex-shrink-0 text-emerald-600" />
          <span>Every part was read straight from the log — nothing to fill in.</span>
        </div>
      )}

      {/* legend */}
      <div className="flex gap-4 pl-0.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-sm bg-emerald-500" /> read from the log</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-sm bg-amber-500" /> we filled it in</span>
      </div>
    </div>
  );
};

const Group: FC<{ g: 'date' | 'time' | 'tz'; children: ReactNode }> = ({ g, children }) => {
  const cfg = GROUPS[g];
  return (
    <div className={g === 'tz' ? 'min-w-0' : ''}>
      <div className={cn('mb-2 ml-1 text-[10px] font-bold uppercase tracking-widest', cfg.text)}>{cfg.label}</div>
      <div className={cn('flex items-start gap-1.5 rounded-[13px] border px-2.5 py-2', g === 'tz' && 'min-w-0', cfg.box)}>{children}</div>
    </div>
  );
};

const SourceOpt: FC<{ label: string; sub: string; selected: boolean; onClick: () => void }>
  = ({ label, sub, selected, onClick }) => (
  <button type="button" onClick={onClick}
    className={cn('flex items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors',
      selected ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white hover:border-violet-200')}>
    <span className={cn('relative h-[15px] w-[15px] flex-shrink-0 rounded-full border-2',
      selected ? 'border-violet-500' : 'border-slate-300')}>
      {selected && <span className="absolute inset-[3px] rounded-full bg-violet-500" />}
    </span>
    <span className="min-w-0">
      <span className="block font-mono text-[13px] font-bold text-slate-800">{label}</span>
      <span className="block max-w-[180px] truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
    </span>
  </button>
);

export default TimestampBuilder;
