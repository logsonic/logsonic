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
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Clock, Settings2, XCircle } from 'lucide-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';

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
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <Clock className="h-4 w-4" />
            Timestamp
          </div>
          <Badge className={visual.className}>
            <Icon className="mr-1 h-3 w-3" />
            {visual.label}
          </Badge>
          {inference.layout.inferred_format_label && (
            <span className="text-xs text-muted-foreground font-mono">
              {inference.layout.inferred_format_label}
            </span>
          )}
          {previewing && (
            <span className="text-xs text-muted-foreground italic">updating preview…</span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSettingsOpen(s => !s)}
          className="h-8"
        >
          {settingsOpen ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
          <Settings2 className="h-3.5 w-3.5 mr-1" />
          Settings
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
        <div className="border rounded p-3 bg-gray-50/50 space-y-3">
          <Knobs
            eff={eff}
            patch={patchOverride}
            sourceMTime={sourceMTime}
            candidates={inference.field_candidates || []}
          />
          {showApplyToAll && activeFile && (
            <div className="flex items-center justify-between border-t pt-2">
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
      {/* Primary: which capture is the timestamp source? */}
      <div className="space-y-1">
        <Label className="text-xs font-medium">Timestamp source field</Label>
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
          <SelectTrigger className="h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={SOURCE_AUTO}>
              <span className="font-medium">Auto-detect</span>
              <span className="text-muted-foreground ml-2">(scan canonical fields)</span>
            </SelectItem>
            {candidates.length > 0 && (
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Captured fields
              </div>
            )}
            {candidates.map(c => (
              <SelectItem key={c.name} value={c.name}>
                <div className="flex items-center gap-2 max-w-[420px]">
                  {c.parses
                    ? <Check className="h-3 w-3 text-emerald-600 flex-shrink-0" />
                    : <span className="h-3 w-3 flex-shrink-0" />}
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground font-mono text-[11px] truncate">
                    {truncate(c.sample)}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Pick which captured field carries the event timestamp. A green check marks fields the resolver could parse automatically.
        </p>
      </div>

      {/* Format hint — only when a non-canonical source is picked. */}
      {isNonCanonicalSource && (
        <div className="space-y-1">
          <Label className="text-xs font-medium">Format</Label>
          <Select
            value={sourceFormatValue}
            onValueChange={(v) => {
              if (v === FORMAT_AUTO) patch({ source_format: '' });
              else if (v === FORMAT_CUSTOM) patch({ source_format: customLayout || '2006-01-02 15:04:05' });
              else patch({ source_format: v });
            }}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {formatPresets.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourceFormatValue === FORMAT_CUSTOM && (
            <Input
              value={customLayout}
              onChange={(e) => patch({ source_format: e.target.value })}
              className="h-8 mt-1 text-xs font-mono"
              placeholder="2006-01-02-15.04.05.000000"
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            Go time layout. The reference is <code className="font-mono">2006-01-02 15:04:05</code> — replace each piece with how it appears in your value.
          </p>
        </div>
      )}

      {/* Secondary: anchor + timezone, side by side. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs font-medium">Anchor</Label>
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
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="file_mtime" disabled={!sourceMTime}>File modification time{!sourceMTime && ' (unavailable)'}</SelectItem>
              <SelectItem value="first_parsed">First parsed timestamp in sample</SelectItem>
              <SelectItem value="custom">Custom date</SelectItem>
              <SelectItem value="now">Now (last resort)</SelectItem>
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
              className="h-8 mt-1 text-xs"
            />
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs font-medium">Source Timezone</Label>
          <Select
            value={eff.timezone.kind}
            onValueChange={(v) => {
              if (v === 'as_parsed') patch({ timezone: { kind: 'as_parsed' } });
              else patch({ timezone: { kind: 'forced', value: eff.timezone.value || 'UTC' } });
            }}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="as_parsed">As captured (default UTC)</SelectItem>
              <SelectItem value="forced">Force a timezone</SelectItem>
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
