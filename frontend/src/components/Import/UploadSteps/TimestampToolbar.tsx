import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { previewTimestamps } from '@/lib/api-client';
import { TimestampInference, TimestampResolution } from '@/lib/api-types';
import { useImportStore } from '@/stores/useImportStore';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Settings2,
  XCircle,
} from 'lucide-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { TimestampBuilder } from './TimestampBuilder';

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
    setTimestampOverrides,
    setTimestampInference,
    setTimestampConfirmed,
    patchFileTimestampOverride,
    setFileTimestampOverrides,
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
  const resetOverrides = () => {
    if (isMultiFile && activeFile) setFileTimestampOverrides(activeFile.id, {});
    else setTimestampOverrides({});
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
          <TimestampBuilder
            inference={inference}
            eff={eff!}
            patch={patchOverride}
            reset={resetOverrides}
            hasOverrides={Object.keys(overrides).length > 0}
            sourceMTime={sourceMTime}
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


export default TimestampToolbar;
