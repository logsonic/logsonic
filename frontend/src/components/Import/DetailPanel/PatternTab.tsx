import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { FC, useState } from 'react';

import { matchRateOf } from '../hooks/useFileDetection';
import { usePatternAlternatives } from '../hooks/usePatternAlternatives';
import { matchColor } from '../utils/importGate';
import { extractFields } from '../utils/patternUtils';

import { CustomPatternEditor } from './CustomPatternEditor';

import type { ImportFile, Pattern } from '../types';
import type { GrokPatternRequest } from '@/lib/api-types';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';

interface PatternTabProps {
  file: ImportFile;
  onChangePattern: (fileId: string, pattern: Pattern) => Promise<void>;
}

const MAX_ALTERNATIVES = 5;

// A saved pattern as the file's selection, plus the timestamp knobs that
// were saved with it. The saved anchor belongs to a previous file's mtime,
// so only the user-meaningful knobs are applied as overrides; detection on
// this file's own sample re-derives the anchor.
function applySavedPattern(
  fileId: string,
  p: GrokPatternRequest,
  change: PatternTabProps['onChangePattern']
) {
  const pattern: Pattern = {
    name: p.name,
    pattern: p.pattern,
    description: p.description || '',
    custom_patterns: p.custom_patterns || {},
    fields: extractFields(p.pattern),
    priority: p.priority,
  };
  const saved = p.timestamp_config;
  if (saved) {
    useImportStore.getState().patchFileTimestampOverride(fileId, {
      year_strategy: saved.year_strategy,
      forced_year: saved.forced_year,
      forced_month: saved.forced_month,
      forced_day: saved.forced_day,
      timezone: saved.timezone,
      rollover: saved.rollover,
      force_mode: saved.force_mode,
    });
  }
  return change(fileId, pattern);
}

export const PatternTab: FC<PatternTabProps> = ({ file, onChangePattern }) => {
  const availablePatterns = useImportStore((s) => s.availablePatterns);
  const { alternatives, scoring } = usePatternAlternatives(file);
  const [editing, setEditing] = useState(file.isCustomPattern);
  const [moreOpen, setMoreOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const selected = file.selectedPattern;
  const detected = file.detectionStatus === 'detected';
  const rate = detected ? matchRateOf(file.parsedLogs, file.previewLines) : 0;

  const pick = async (name: string) => {
    const p = availablePatterns.find((x) => x.name === name);
    if (!p) return;
    setMoreOpen(false);
    if (p.name === DEFAULT_PATTERN.name) {
      setEditing(true);
      return;
    }
    setSwitching(p.name);
    try {
      await applySavedPattern(file.id, p, onChangePattern);
    } finally {
      setSwitching(null);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <CustomPatternEditor
        file={file}
        onChangePattern={onChangePattern}
        onBack={() => setEditing(false)}
        canGoBack={!!selected && !file.isCustomPattern}
      />
    );
  }

  return (
    <div className="ls-rise">
      {file.detectionError && (
        <div
          className="ls-imp-card ls-imp-card--warn flex items-start"
          style={{ gap: 8, marginBottom: 12 }}
        >
          <AlertTriangle
            size={14}
            style={{ color: 'var(--ls-warn)', flexShrink: 0, marginTop: 1 }}
          />
          <span style={{ fontSize: 12, color: 'var(--ls-warn)' }}>{file.detectionError}</span>
        </div>
      )}

      <div className="ls-imp-label" style={{ marginBottom: 8 }}>
        Selected
      </div>
      {selected ? (
        <div className={`ls-imp-card ${detected ? 'ls-imp-card--ok' : ''}`}>
          <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
            <span
              className="truncate"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: detected ? 'var(--ls-ok)' : 'var(--ls-text)',
              }}
            >
              {selected.name}
            </span>
            <span
              className="ls-imp-mono flex-shrink-0"
              style={{ fontSize: 12, color: detected ? matchColor(rate) : 'var(--ls-text-3)' }}
            >
              {switching ? (
                <Loader2 size={12} className="animate-spin" />
              ) : detected ? (
                `${rate}% match`
              ) : (
                'not tested'
              )}
            </span>
          </div>
          <div
            className="ls-imp-mono"
            style={{
              marginTop: 6,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: 'var(--ls-text-2)',
              overflowWrap: 'anywhere',
            }}
          >
            {selected.pattern}
          </div>
          {selected.fields && selected.fields.length > 0 && (
            <div className="flex flex-wrap" style={{ gap: 4, marginTop: 8 }}>
              {selected.fields.map((f) => (
                <span
                  key={f}
                  className="ls-imp-fieldchip"
                  style={{
                    background: 'var(--ls-panel)',
                    border: '1px solid var(--ls-border)',
                    color: 'var(--ls-text-2)',
                  }}
                >
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="ls-imp-card" style={{ fontSize: 12.5, color: 'var(--ls-text-3)' }}>
          No pattern yet — pick one below or write your own.
        </div>
      )}

      <div className="ls-imp-label flex items-center" style={{ gap: 8, margin: '16px 0 4px' }}>
        Alternatives
        {scoring && (
          <Loader2 size={11} className="animate-spin" style={{ color: 'var(--ls-text-4)' }} />
        )}
      </div>
      {alternatives.length === 0 ? (
        <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--ls-text-3)' }}>
          {scoring ? 'Testing saved patterns…' : 'No other saved pattern matches this file.'}
        </div>
      ) : (
        alternatives.slice(0, MAX_ALTERNATIVES).map(({ pattern, match }) => (
          <button
            key={pattern.name}
            type="button"
            className="ls-imp-altrow"
            onClick={() => pick(pattern.name)}
            disabled={!!switching}
            title={pattern.pattern}
          >
            <span
              className="truncate"
              style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}
            >
              {pattern.name}
            </span>
            <span
              className="ls-imp-mono flex-shrink-0"
              style={{ fontSize: 11.5, color: scoring ? 'var(--ls-text-4)' : matchColor(match) }}
            >
              {switching === pattern.name ? (
                <Loader2 size={12} className="animate-spin" />
              ) : scoring ? (
                '…'
              ) : (
                `${match}%`
              )}
            </span>
          </button>
        ))
      )}

      <div
        className="flex flex-col"
        style={{
          gap: 6,
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--ls-border-subtle)',
        }}
      >
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="ls-imp-link" style={{ fontSize: 12 }}>
              More patterns →
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[320px] p-0">
            <Command>
              <CommandInput placeholder="Search patterns…" className="h-9" autoFocus />
              <CommandList>
                <CommandEmpty>No pattern found.</CommandEmpty>
                <CommandGroup className="max-h-[240px] overflow-auto">
                  {availablePatterns
                    .filter((p) => p.name !== DEFAULT_PATTERN.name)
                    .map((p) => (
                      <CommandItem
                        key={p.name}
                        value={`${p.name} ${p.description ?? ''}`}
                        onSelect={() => pick(p.name)}
                        className="flex items-center px-2 py-1.5 text-sm cursor-pointer"
                      >
                        <Check
                          className="mr-2 h-3 w-3 flex-shrink-0"
                          style={{ opacity: selected?.name === p.name ? 1 : 0 }}
                        />
                        <span className="truncate">
                          <b>{p.name}</b>
                          {p.description ? (
                            <span style={{ color: 'var(--ls-text-3)' }}>: {p.description}</span>
                          ) : null}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="ls-imp-link"
          style={{ fontSize: 12 }}
          onClick={() => setEditing(true)}
        >
          Write custom pattern →
        </button>
      </div>
    </div>
  );
};

export default PatternTab;
