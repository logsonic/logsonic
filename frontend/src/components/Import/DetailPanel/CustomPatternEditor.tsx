import { ArrowLeft, Loader2, X } from 'lucide-react';
import { FC, Fragment, useCallback, useRef, useState } from 'react';

import { matchRateOf } from '../hooks/useFileDetection';
import { fieldTones } from '../utils/fieldTone';
import { COMMON_GROK_PATTERNS } from '../utils/grokTokens';
import { matchColor } from '../utils/importGate';
import { extractFields } from '../utils/patternUtils';

import type { ImportFile, Pattern } from '../types';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';

// Syntax echo of a grok string: braces / token name / ':' / field / literal.
function GrokEcho({ pattern }: { pattern: string }) {
  const re = /%{([^:}]+)(?::([^}]+))?}/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(pattern)) !== null) {
    if (m.index > last) {
      parts.push(
        <span key={`t${i}`} className="ls-imp-grok-text">
          {pattern.slice(last, m.index)}
        </span>
      );
    }
    parts.push(
      <span key={`p${i}`} style={{ whiteSpace: 'nowrap' }}>
        <span className="ls-imp-grok-brace">%{'{'}</span>
        <span className="ls-imp-grok-name">{m[1]}</span>
        {m[2] && (
          <>
            <span className="ls-imp-grok-sep">:</span>
            <span className="ls-imp-grok-field">{m[2]}</span>
          </>
        )}
        <span className="ls-imp-grok-brace">{'}'}</span>
      </span>
    );
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < pattern.length) {
    parts.push(
      <span key="tail" className="ls-imp-grok-text">
        {pattern.slice(last)}
      </span>
    );
  }
  return (
    <div className="ls-imp-echo">
      {parts.length > 0 ? parts : <span className="ls-imp-grok-text">&nbsp;</span>}
    </div>
  );
}

const TokenChip: FC<{
  name: string;
  keyName: string;
  description: string;
  custom?: boolean;
  selected?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}> = ({ name, keyName, description, custom, selected, onClick, onDelete }) => (
  <TooltipProvider delayDuration={300}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`ls-imp-token${custom ? ' ls-imp-token--custom' : ''}${selected ? ' ls-imp-token--selected' : ''}`}
          draggable
          role="button"
          tabIndex={0}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', `%{${name}:${keyName}}`);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick();
            }
          }}
        >
          {name}
          {custom && onDelete && (
            <button
              type="button"
              aria-label={`Remove token ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={{
                display: 'inline-flex',
                background: 'transparent',
                border: 0,
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <X size={10} />
            </button>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-semibold">{name}</p>
        <p className="text-xs font-mono">{description}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

interface CustomPatternEditorProps {
  file: ImportFile;
  onChangePattern: (fileId: string, pattern: Pattern) => Promise<void>;
  onBack: () => void;
  canGoBack: boolean;
}

/**
 * Inline Grok editor for one file. The draft (name, pattern, custom
 * tokens) lives on the file record (`customPattern` /
 * `customPatternTokens`) so it survives tab switches; "Test pattern"
 * re-parses the preview and makes it the file's selected pattern, keeping
 * the selection named "Custom Pattern" so the save dialog fires at import.
 */
export const CustomPatternEditor: FC<CustomPatternEditorProps> = ({
  file,
  onChangePattern,
  onBack,
  canGoBack,
}) => {
  const updateFile = useImportStore((s) => s.updateFile);
  const initialPattern =
    file.customPattern?.pattern ??
    (file.isCustomPattern ? file.selectedPattern?.pattern : undefined) ??
    '';
  const [name, setName] = useState(file.customPattern?.name || DEFAULT_PATTERN.name);
  const [text, setText] = useState(
    initialPattern === DEFAULT_PATTERN.pattern ? '' : initialPattern
  );
  const [tokens, setTokens] = useState<Record<string, string>>(file.customPatternTokens || {});
  const [lastInserted, setLastInserted] = useState<string | null>(null);
  const [showAddToken, setShowAddToken] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenRegex, setNewTokenRegex] = useState('');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ rate: number; fields: string[] } | null>(
    file.isCustomPattern && file.detectionStatus === 'detected' && file.selectedPattern
      ? {
          rate: matchRateOf(file.parsedLogs, file.previewLines),
          fields: file.selectedPattern.fields ?? [],
        }
      : null
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const persistDraft = useCallback(
    (next: { name?: string; pattern?: string; tokens?: Record<string, string> }) => {
      const n = next.name ?? name;
      const p = next.pattern ?? text;
      const t = next.tokens ?? tokens;
      updateFile(file.id, {
        customPattern: {
          ...DEFAULT_PATTERN,
          name: n,
          pattern: p,
          fields: extractFields(p),
          custom_patterns: t,
        },
        customPatternTokens: t,
      });
    },
    [file.id, name, text, tokens, updateFile]
  );

  const setPattern = (p: string) => {
    setText(p);
    setTested(null);
    persistDraft({ pattern: p });
  };

  // Insert at a position, adding a space before when the text there does
  // not already end with one (same rule as the wizard's editor).
  const insertAt = (token: string, at: number) => {
    const before = text.slice(0, at);
    const after = text.slice(at);
    const needsSpace = at > 0 && !before.endsWith(' ');
    const next = before + (needsSpace ? ' ' : '') + token + after;
    setPattern(next);
    const caret = at + token.length + (needsSpace ? 1 : 0);
    window.setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    }, 0);
  };
  const insertAtCaret = (token: string, tokenName: string) => {
    const ta = textareaRef.current;
    insertAt(token, ta ? ta.selectionStart : text.length);
    setLastInserted(tokenName);
  };
  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const token = e.dataTransfer.getData('text/plain');
    if (!token) return;
    const doc = e.currentTarget.ownerDocument;
    const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    let at = text.length;
    if (range) {
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      at = e.currentTarget.selectionStart ?? text.length;
    }
    insertAt(token, at);
  };

  const addToken = () => {
    if (!newTokenName.trim() || !newTokenRegex.trim()) return;
    const next = { ...tokens, [newTokenName.trim()]: newTokenRegex };
    setTokens(next);
    persistDraft({ tokens: next });
    setNewTokenName('');
    setNewTokenRegex('');
    setShowAddToken(false);
    setTested(null);
  };
  const removeToken = (n: string) => {
    const next = { ...tokens };
    delete next[n];
    setTokens(next);
    persistDraft({ tokens: next });
    setTested(null);
  };

  const test = async () => {
    if (!text.trim()) return;
    setTesting(true);
    persistDraft({});
    const pattern: Pattern = {
      ...DEFAULT_PATTERN,
      pattern: text,
      fields: extractFields(text),
      custom_patterns: tokens,
    };
    await onChangePattern(file.id, pattern);
    const after = useImportStore.getState().files.find((f) => f.id === file.id);
    setTesting(false);
    if (after && after.detectionStatus === 'detected') {
      setTested({
        rate: matchRateOf(after.parsedLogs, after.previewLines),
        fields: extractFields(text),
      });
    } else {
      setTested(null);
    }
  };

  const tones = tested ? fieldTones(tested.fields) : {};
  const fileAfter = useImportStore((s) => s.files.find((f) => f.id === file.id));
  const testError = fileAfter?.isCustomPattern ? fileAfter.detectionError : null;

  return (
    <div className="ls-rise">
      {canGoBack && (
        <button
          type="button"
          className="ls-imp-link inline-flex items-center"
          style={{ gap: 4, marginBottom: 12 }}
          onClick={onBack}
        >
          <ArrowLeft size={12} /> Back to detected patterns
        </button>
      )}

      <div className="ls-imp-label" style={{ marginBottom: 6 }}>
        Pattern name
      </div>
      <input
        className="ls-imp-input"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          persistDraft({ name: e.target.value });
        }}
        placeholder="Custom Pattern"
        aria-label="Pattern name"
      />

      <div className="ls-imp-label" style={{ margin: '14px 0 6px' }}>
        Grok pattern
      </div>
      <textarea
        ref={textareaRef}
        className="ls-imp-input ls-imp-input--mono"
        rows={3}
        value={text}
        onChange={(e) => setPattern(e.target.value)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        placeholder="%{TIMESTAMP:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}"
        aria-label="Grok pattern"
        spellCheck={false}
        style={{ resize: 'vertical' }}
      />
      <div style={{ marginTop: 6 }}>
        <GrokEcho pattern={text} />
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ls-text-2)' }}>
        Click a token to insert it at the caret, or drag it into the pattern.
      </div>

      <div className="flex flex-wrap" style={{ gap: 6, marginTop: 10 }}>
        {COMMON_GROK_PATTERNS.map((t) => (
          <TokenChip
            key={t.name}
            name={t.name}
            keyName={t.key}
            description={t.description}
            selected={lastInserted === t.name}
            onClick={() => insertAtCaret(`%{${t.name}:${t.key}}`, t.name)}
          />
        ))}
        {Object.entries(tokens).map(([n, regex]) => (
          <TokenChip
            key={n}
            name={n}
            keyName={n.toLowerCase()}
            description={regex}
            custom
            selected={lastInserted === n}
            onClick={() => insertAtCaret(`%{${n}:${n.toLowerCase()}}`, n)}
            onDelete={() => removeToken(n)}
          />
        ))}
        <button
          type="button"
          className="ls-imp-token ls-imp-token--add"
          onClick={() => setShowAddToken((v) => !v)}
        >
          + Custom token
        </button>
      </div>

      {showAddToken && (
        <div className="ls-imp-card ls-imp-card--accent ls-rise" style={{ marginTop: 10 }}>
          <div className="flex flex-col" style={{ gap: 8 }}>
            <input
              className="ls-imp-input ls-imp-input--mono"
              placeholder="Token name, e.g. CUSTOM_DATE"
              value={newTokenName}
              onChange={(e) =>
                setNewTokenName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
              }
              aria-label="Custom token name"
            />
            <input
              className="ls-imp-input ls-imp-input--mono"
              placeholder={String.raw`Regex, e.g. \d{4}-\d{2}-\d{2}`}
              value={newTokenRegex}
              onChange={(e) => setNewTokenRegex(e.target.value)}
              aria-label="Custom token regex"
            />
            <div>
              <button
                type="button"
                className="ls-imp-btn"
                disabled={!newTokenName.trim() || !newTokenRegex.trim()}
                onClick={addToken}
              >
                Add token
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center" style={{ gap: 12, marginTop: 14 }}>
        <button
          type="button"
          className="ls-imp-btn"
          disabled={testing || !text.trim()}
          onClick={test}
        >
          {testing && <Loader2 size={12} className="animate-spin" />}
          {testing ? 'Testing…' : 'Test pattern'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--ls-text-3)' }}>
          You can save it as a reusable pattern when you import.
        </span>
      </div>

      {testError && (
        <div
          className="ls-imp-card ls-imp-card--err"
          style={{ marginTop: 12, fontSize: 12, color: 'var(--ls-err)' }}
        >
          {testError}
        </div>
      )}

      {tested && !testError && (
        <div className="ls-imp-card ls-imp-card--ok ls-rise" style={{ marginTop: 12 }}>
          <div className="flex items-baseline justify-between">
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ls-ok)' }}>
              Pattern tested
            </span>
            <span className="ls-imp-mono" style={{ fontSize: 12, color: matchColor(tested.rate) }}>
              {tested.rate}% match
            </span>
          </div>
          {tested.fields.length > 0 && (
            <div className="flex flex-wrap" style={{ gap: 4, marginTop: 8 }}>
              {tested.fields.map((f) => (
                <Fragment key={f}>
                  <span
                    className={`ls-imp-fieldchip ls-imp-field--${tones[f] === 'plain' ? 'gray' : tones[f]}`}
                  >
                    {f}
                  </span>
                </Fragment>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ls-text-2)' }}>
            The preview on the right is parsed with this pattern. You will be offered to save it as
            a reusable pattern when you import.
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomPatternEditor;
