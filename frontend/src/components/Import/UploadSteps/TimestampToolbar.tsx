import { TimezoneSelectorCommon } from '@/components/common/TimezoneSelectorCommon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { previewTimestamps } from '@/lib/api-client';
import {
  AnchorKind,
  FieldCandidate,
  ForceMode,
  TimestampInference,
  TimestampResolution,
  YearStrategy,
} from '@/lib/api-types';
import { useImportStore } from '@/stores/useImportStore';
import {
  AlertTriangle,
  Anchor as AnchorIcon,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Code2,
  FileClock,
  Globe,
  Hash,
  Lock,
  Settings2,
  Sparkles,
  Tag,
  Timer,
  Wand2,
  XCircle,
  Zap,
} from 'lucide-react';
import { FC, ReactNode, useEffect, useMemo, useRef, useState } from 'react';

// Sentinel value for the source-field dropdown. Empty string would
// confuse Radix's Select; a non-empty string keeps it controlled.
const SOURCE_AUTO = '__auto__';

// Pre-canned format presets exposed through the dropdown when the
// user picks a non-canonical source field. "auto" lets the resolver
// run its dateparse + unix-epoch + layout cascade. "custom" reveals
// a Go-layout text input.
const FORMAT_AUTO = '__auto__';
const FORMAT_CUSTOM = '__custom__';
const formatPresets = [
  { value: FORMAT_AUTO,   label: 'Auto-detect' },
  { value: 'unix_seconds', label: 'Unix epoch (seconds)' },
  { value: 'unix_millis',  label: 'Unix epoch (milliseconds)' },
  { value: 'unix_nanos',   label: 'Unix epoch (nano/microseconds)' },
  { value: FORMAT_CUSTOM,  label: 'Custom Go layout…' },
];

// Effective resolution = inferred defaults overlaid with user overrides.
function effective(inf: TimestampInference | null, overrides: Partial<TimestampResolution>): TimestampResolution | null {
  if (!inf) return null;
  return {
    ...inf.resolution,
    ...overrides,
    anchor: overrides.anchor ?? inf.resolution.anchor,
    timezone: overrides.timezone ?? inf.resolution.timezone,
  };
}

// Visual mapping from status to chip styling + icon.
const statusVisuals: Record<string, { className: string; label: string; icon: typeof CheckCircle2 }> = {
  exact:     { className: 'bg-emerald-100 text-emerald-900 border-emerald-200 hover:bg-emerald-100', label: 'Detected',  icon: CheckCircle2 },
  inferred:  { className: 'bg-sky-100 text-sky-900 border-sky-200 hover:bg-sky-100',                 label: 'Inferred',  icon: Clock },
  ambiguous: { className: 'bg-amber-100 text-amber-900 border-amber-200 hover:bg-amber-100',         label: 'Ambiguous', icon: AlertTriangle },
  missing:   { className: 'bg-rose-100 text-rose-900 border-rose-200 hover:bg-rose-100',             label: 'Missing',   icon: XCircle },
};

// Reusable row used inside SelectItems so each option carries an icon
// chip with its own accent color, the option label, and an optional
// hint. Keeps the dropdowns scan-able even when there are many options.
type Tone = 'violet' | 'sky' | 'emerald' | 'amber' | 'rose' | 'slate' | 'indigo' | 'cyan';
const toneClasses: Record<Tone, { bg: string; text: string }> = {
  violet:  { bg: 'bg-violet-100',  text: 'text-violet-700'  },
  sky:     { bg: 'bg-sky-100',     text: 'text-sky-700'     },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  amber:   { bg: 'bg-amber-100',   text: 'text-amber-700'   },
  rose:    { bg: 'bg-rose-100',    text: 'text-rose-700'    },
  slate:   { bg: 'bg-slate-100',   text: 'text-slate-700'   },
  indigo:  { bg: 'bg-indigo-100',  text: 'text-indigo-700'  },
  cyan:    { bg: 'bg-cyan-100',    text: 'text-cyan-700'    },
};

const OptionRow: FC<{
  icon: typeof Clock;
  tone: Tone;
  label: ReactNode;
  hint?: ReactNode;
}> = ({ icon: Icon, tone, label, hint }) => {
  const t = toneClasses[tone];
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className={`flex h-6 w-6 items-center justify-center rounded-md ${t.bg} ${t.text} flex-shrink-0`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 min-w-0 truncate">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-muted-foreground ml-1.5 text-[11px]">{hint}</span>}
      </span>
    </div>
  );
};

// Section header used inside the knob drawer. Pairs a colored icon
// chip with the section label so the four panels (source, format,
// anchor, timezone) each have their own visual signature.
const SectionLabel: FC<{ icon: typeof Clock; tone: Tone; children: ReactNode }> = ({
  icon: Icon,
  tone,
  children,
}) => {
  const t = toneClasses[tone];
  return (
    <div className="flex items-center gap-2">
      <span className={`flex h-5 w-5 items-center justify-center rounded ${t.bg} ${t.text}`}>
        <Icon className="h-3 w-3" />
      </span>
      <Label className="text-xs font-semibold text-slate-700">{children}</Label>
    </div>
  );
};

// TimestampToolbar is the chip + format label + warnings + collapsible
// knob drawer + confirmation gate. It deliberately does NOT render its
// own preview rows — those live inside the log-preview table now, with
// the resolved time appearing as a leading column on each row.
//
// Mounted at the top of PatternTestResults so the user sees one card
// that both shows how their grok pattern parses the line AND how the
// resolver renders the wall-clock timestamp.
export const TimestampToolbar: FC = () => {
  const {
    timestampInference: globalInference,
    timestampOverrides: globalOverrides,
    timestampConfirmed: globalConfirmed,
    sourceMTime: globalMTime,
    selectedPattern,
    filePreviewBuffer,
    getActiveFile,
    files,
    importSource,
    patchTimestampOverride,
    setTimestampInference,
    setTimestampConfirmed,
    patchFileTimestampOverride,
    setFileTimestampInference,
    setFileTimestampConfirmed,
    applyTimestampToAllFiles,
  } = useImportStore();

  const activeFile = getActiveFile();
  const isMultiFile = importSource === 'file' && files.length > 0 && !!activeFile;

  const inference = isMultiFile ? (activeFile?.timestampInference ?? null) : globalInference;
  const overrides = isMultiFile ? (activeFile?.timestampOverrides ?? {}) : globalOverrides;
  const confirmed = isMultiFile ? (activeFile?.timestampConfirmed ?? false) : globalConfirmed;
  const sourceMTime = isMultiFile ? (activeFile?.sourceMTime ?? null) : globalMTime;
  const previewLines: string[] = filePreviewBuffer?.lines ?? activeFile?.previewLines ?? [];

  const patchOverride = (patch: Partial<TimestampResolution>) => {
    if (isMultiFile && activeFile) patchFileTimestampOverride(activeFile.id, patch);
    else patchTimestampOverride(patch);
  };
  const setConfirmed = (c: boolean) => {
    if (isMultiFile && activeFile) setFileTimestampConfirmed(activeFile.id, c);
    else setTimestampConfirmed(c);
  };
  const setInferenceForActive = (inf: TimestampInference | null) => {
    if (isMultiFile && activeFile) setFileTimestampInference(activeFile.id, inf);
    else setTimestampInference(inf);
  };

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const debounceRef = useRef<number | null>(null);

  const eff = useMemo(() => effective(inference, overrides), [inference, overrides]);

  // Auto-open settings drawer when user attention is needed, but only
  // once when the inference status flips into ambiguous/missing —
  // collapsing it should stick if the user closes it back.
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!inference) return;
    const prev = lastStatusRef.current;
    lastStatusRef.current = inference.status;
    if (prev !== inference.status && (inference.status === 'ambiguous' || inference.status === 'missing')) {
      setSettingsOpen(true);
    }
  }, [inference?.status]);

  // Debounced live re-preview against /timestamp/preview when knobs
  // change. Updates the inference (which the parent uses to render
  // the resolved-time column for each row).
  useEffect(() => {
    if (!inference || previewLines.length === 0 || !selectedPattern || Object.keys(overrides).length === 0) {
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await previewTimestamps({
          logs: previewLines.slice(0, 20),
          grok_pattern: selectedPattern.pattern,
          custom_patterns: selectedPattern.custom_patterns || {},
          resolution: eff || {},
          source_mtime: sourceMTime || undefined,
        });
        if (res.status === 'success') {
          setInferenceForActive(res.inference);
        }
      } finally {
        setPreviewing(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [overrides, previewLines, selectedPattern, sourceMTime, activeFile?.id]);

  if (!inference) {
    return null;
  }

  const status = inference.status;
  const visual = statusVisuals[status] || statusVisuals.inferred;
  const Icon = visual.icon;
  const showApplyToAll = isMultiFile && files.length > 1;
  const needsConfirm = (status === 'ambiguous' || status === 'missing') && !confirmed;

  return (
    <div className="space-y-2">
      {/* Header strip — chip + format label + settings cog */}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-700">
              <Clock className="h-4 w-4" />
            </span>
            Timestamp
          </div>
          <Badge className={visual.className}>
            <Icon className="mr-1 h-3 w-3" />
            {visual.label}
          </Badge>
          {inference.layout.inferred_format_label && (
            <span className="text-xs text-muted-foreground font-mono bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">
              {inference.layout.inferred_format_label}
            </span>
          )}
          {previewing && (
            <span className="text-xs text-muted-foreground italic flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              updating preview…
            </span>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setSettingsOpen(s => !s)}
          className={`h-8 gap-1.5 transition-colors ${
            settingsOpen
              ? 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100 hover:text-violet-800'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
          aria-expanded={settingsOpen}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Settings
          {settingsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Warnings — always visible when present */}
      {inference.warnings && inference.warnings.length > 0 && (
        <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
          {inference.warnings.map((w, i) => (
            <li key={i} className="flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Collapsible knob drawer */}
      {settingsOpen && (
        <div className="border border-slate-200 rounded-lg p-4 bg-gradient-to-br from-slate-50 to-white shadow-sm space-y-4">
          <Knobs
            eff={eff}
            patch={patchOverride}
            sourceMTime={sourceMTime}
            candidates={inference.field_candidates || []}
          />
          {showApplyToAll && activeFile && (
            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <span className="text-xs text-muted-foreground">
                Reuse these settings for the other {files.length - 1} file{files.length - 1 === 1 ? '' : 's'} in this batch.
              </span>
              <Button size="sm" variant="outline" onClick={() => applyTimestampToAllFiles(activeFile.id)}>
                Apply to all
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Confirmation gate */}
      {needsConfirm && (
        <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded p-2">
          <span className="text-xs text-amber-900">
            Review the resolved timestamps below and confirm before importing.
          </span>
          <Button size="sm" onClick={() => setConfirmed(true)}>
            Looks correct
          </Button>
        </div>
      )}
      {confirmed && (status === 'ambiguous' || status === 'missing') && (
        <div className="text-xs text-emerald-700 flex items-center gap-1 px-1">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Confirmed.
        </div>
      )}
    </div>
  );
};

interface KnobsProps {
  eff: TimestampResolution | null;
  patch: (p: Partial<TimestampResolution>) => void;
  sourceMTime: string | null;
  candidates: FieldCandidate[];
}

// truncate keeps the dropdown readable when a sample value is huge
// (raw lines, JSON blobs, etc).
const truncate = (s: string, n = 40) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

const Knobs: FC<KnobsProps> = ({ eff, patch, sourceMTime, candidates }) => {
  if (!eff) return null;
  const anchorIso = eff.anchor.value ? new Date(eff.anchor.value).toISOString().slice(0, 10) : '';
  const sourceFieldValue = eff.source_field?.trim() ? eff.source_field : SOURCE_AUTO;
  const sourceFormatValue = (() => {
    const v = eff.source_format?.trim();
    if (!v) return FORMAT_AUTO;
    if (v === 'unix_seconds' || v === 'unix_millis' || v === 'unix_nanos') return v;
    return FORMAT_CUSTOM;
  })();
  const customLayout = sourceFormatValue === FORMAT_CUSTOM ? (eff.source_format ?? '') : '';
  const isNonCanonicalSource = sourceFieldValue !== SOURCE_AUTO;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-3">
      {/* Primary row: source field + format share one row.
          When the source is auto-detect (canonical), the format selector is
          implicitly auto and we hide it to keep the layout calm. */}
      <div className={`grid gap-3 ${isNonCanonicalSource ? 'grid-cols-1 md:grid-cols-[1fr_minmax(220px,1fr)]' : 'grid-cols-1'}`}>
        <div className="space-y-1.5 min-w-0">
          <SectionLabel icon={Tag} tone="violet">Timestamp source field</SectionLabel>
          <Select
            value={sourceFieldValue}
            onValueChange={(v) => {
              if (v === SOURCE_AUTO) {
                patch({ source_field: '', source_format: '' });
              } else {
                const cand = candidates.find(c => c.name === v);
                patch({
                  source_field: v,
                  // Adopt the detected format hint when available so the
                  // user doesn't have to think about layouts unless the
                  // detector failed.
                  source_format: cand?.format && cand.format !== 'auto' ? cand.format : '',
                });
              }
            }}
          >
            <SelectTrigger className="h-10 text-xs bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value={SOURCE_AUTO}>
                <OptionRow
                  icon={Wand2}
                  tone="violet"
                  label="Auto-detect"
                  hint="scan canonical fields"
                />
              </SelectItem>
              {candidates.length > 0 && (
                <div className="px-2 py-1 mt-1 text-[10px] uppercase tracking-wider text-muted-foreground border-t">
                  Captured fields
                </div>
              )}
              {candidates.map(c => (
                <SelectItem key={c.name} value={c.name}>
                  <OptionRow
                    icon={c.parses ? Check : Tag}
                    tone={c.parses ? 'emerald' : 'slate'}
                    label={c.name}
                    hint={<span className="font-mono">{truncate(c.sample)}</span>}
                  />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isNonCanonicalSource && (
          <div className="space-y-1.5 min-w-0">
            <SectionLabel icon={Code2} tone="indigo">Format</SectionLabel>
            <Select
              value={sourceFormatValue}
              onValueChange={(v) => {
                if (v === FORMAT_AUTO) patch({ source_format: '' });
                else if (v === FORMAT_CUSTOM) patch({ source_format: customLayout || '2006-01-02 15:04:05' });
                else patch({ source_format: v });
              }}
            >
              <SelectTrigger className="h-10 text-xs bg-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FORMAT_AUTO}>
                  <OptionRow icon={Sparkles} tone="violet" label="Auto-detect" hint="parse with cascade" />
                </SelectItem>
                <SelectItem value="unix_seconds">
                  <OptionRow icon={Hash} tone="cyan" label="Unix epoch" hint="seconds" />
                </SelectItem>
                <SelectItem value="unix_millis">
                  <OptionRow icon={Timer} tone="cyan" label="Unix epoch" hint="milliseconds" />
                </SelectItem>
                <SelectItem value="unix_nanos">
                  <OptionRow icon={Zap} tone="cyan" label="Unix epoch" hint="nano/microseconds" />
                </SelectItem>
                <SelectItem value={FORMAT_CUSTOM}>
                  <OptionRow icon={Code2} tone="indigo" label="Custom Go layout…" />
                </SelectItem>
              </SelectContent>
            </Select>
            {sourceFormatValue === FORMAT_CUSTOM && (
              <Input
                value={customLayout}
                onChange={(e) => patch({ source_format: e.target.value })}
                className="h-9 mt-1 text-xs font-mono bg-white"
                placeholder="2006-01-02-15.04.05.000000"
              />
            )}
          </div>
        )}
      </div>

      {/* Helper text — single line below the primary row, adapts based on
          which selectors are visible. */}
      <p className="text-[11px] text-muted-foreground pl-7 -mt-1">
        Pick which captured field carries the event timestamp. A green check marks fields the resolver could parse automatically.
        {isNonCanonicalSource && (
          <>
            {' '}Format is the Go time layout; reference is <code className="font-mono">2006-01-02 15:04:05</code>.
          </>
        )}
      </p>

      {/* Secondary: anchor + timezone, side by side. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <SectionLabel icon={AnchorIcon} tone="amber">Anchor</SectionLabel>
          <Select
            value={eff.anchor.kind}
            onValueChange={(kind) => {
              const k = kind as AnchorKind;
              let value = eff.anchor.value;
              if (k === 'file_mtime' && sourceMTime) value = sourceMTime;
              if (k === 'now') value = new Date().toISOString();
              patch({ anchor: { kind: k, value } });
            }}
          >
            <SelectTrigger className="h-10 text-xs bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="file_mtime" disabled={!sourceMTime}>
                <OptionRow
                  icon={FileClock}
                  tone="amber"
                  label="File modification time"
                  hint={!sourceMTime ? '(unavailable)' : undefined}
                />
              </SelectItem>
              <SelectItem value="first_parsed">
                <OptionRow icon={ChevronsUpDown} tone="emerald" label="First parsed" hint="from sample" />
              </SelectItem>
              <SelectItem value="custom">
                <OptionRow icon={Calendar} tone="indigo" label="Custom date" />
              </SelectItem>
              <SelectItem value="now">
                <OptionRow icon={CalendarClock} tone="rose" label="Now" hint="last resort" />
              </SelectItem>
            </SelectContent>
          </Select>
          {eff.anchor.kind === 'custom' && (
            <Input
              type="date"
              value={anchorIso}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                patch({ anchor: { kind: 'custom', value: new Date(v).toISOString() } });
              }}
              className="h-9 mt-1 text-xs bg-white"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <SectionLabel icon={Globe} tone="sky">Source Timezone</SectionLabel>
          <Select
            value={eff.timezone.kind}
            onValueChange={(v) => {
              if (v === 'as_parsed') patch({ timezone: { kind: 'as_parsed' } });
              else patch({ timezone: { kind: 'forced', value: eff.timezone.value || 'UTC' } });
            }}
          >
            <SelectTrigger className="h-10 text-xs bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="as_parsed">
                <OptionRow icon={Globe} tone="sky" label="As captured" hint="default UTC" />
              </SelectItem>
              <SelectItem value="forced">
                <OptionRow icon={Lock} tone="indigo" label="Force a timezone" />
              </SelectItem>
            </SelectContent>
          </Select>
          {eff.timezone.kind === 'forced' && (
            <TimezoneSelectorCommon
              selectedTimezone={eff.timezone.value || 'UTC'}
              onTimezoneChange={(tz) => patch({ timezone: { kind: 'forced', value: tz } })}
              label="Source timezone"
              placeholder="UTC"
            />
          )}
        </div>
      </div>

      {/* Advanced — collapsed by default. Holds the rarely-touched
          year strategy / force mode / rollover toggles. */}
      <div className="border-t pt-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-gray-900"
        >
          {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Advanced
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Year strategy</Label>
              <Select
                value={eff.year_strategy}
                onValueChange={(v) => patch({ year_strategy: v as YearStrategy })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="parsed">Use year from line</SelectItem>
                  <SelectItem value="inferred_century">Expand 2-digit year (vs anchor)</SelectItem>
                  <SelectItem value="from_anchor">Borrow from anchor</SelectItem>
                  <SelectItem value="forced">Force a specific year</SelectItem>
                </SelectContent>
              </Select>
              {eff.year_strategy === 'forced' && (
                <Input
                  type="number"
                  min={1900}
                  max={2100}
                  value={eff.forced_year ?? ''}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    patch({ forced_year: Number.isFinite(n) ? n : undefined });
                  }}
                  className="h-8 mt-1 text-xs"
                  placeholder="YYYY"
                />
              )}
            </div>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs font-medium">Force-override mode</Label>
                <Select
                  value={eff.force_mode}
                  onValueChange={(v) => patch({ force_mode: v as ForceMode })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fill_missing">Fill missing only</SelectItem>
                    <SelectItem value="overwrite">Overwrite (legacy)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between pt-1">
                <Label className="text-xs font-medium">Rollover detection</Label>
                <Switch checked={eff.rollover} onCheckedChange={(b) => patch({ rollover: b })} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TimestampToolbar;
