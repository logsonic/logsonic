import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const valueColors: Record<string, string> = {
  string: 'var(--ls-ok)',
  number: 'var(--ls-warn)',
  boolean: 'var(--ls-accent)',
  object: 'var(--ls-text-3)', // null
};

const JsonCopyButton = ({ value, path }: { value: unknown; path: string }) => {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2) ?? 'null');
      setStatus('Copied');
    } catch {
      setStatus('Copy failed');
    }
    timer.current = setTimeout(() => setStatus(''), 2000);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Copy JSON at ${path}`}
        title="Copy as JSON"
        onClick={copy}
        className="rounded p-1 hover:bg-[var(--ls-bg-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ls-accent)]"
        style={{ color: 'var(--ls-text-2)' }}
      >
        {status === 'Copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span role="status" style={{ fontSize: 11, color: 'var(--ls-text-2)' }}>
        {status}
      </span>
    </span>
  );
};

interface NodeProps {
  value: unknown;
  path: string;
  name?: string;
  isLast?: boolean;
  expandedByDefault: boolean;
  overrides: Record<string, boolean>;
  toggle: (path: string, expanded: boolean) => void;
}

const JsonNode = ({
  value,
  path,
  name,
  isLast = true,
  expandedByDefault,
  overrides,
  toggle,
}: NodeProps) => {
  const isContainer = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const entries = isContainer ? Object.entries(value) : [];
  const expanded = overrides[path] ?? expandedByDefault;
  const opening = isArray ? '[' : '{';
  const closing = isArray ? ']' : '}';
  const label =
    name === undefined ? null : (
      <span style={{ color: 'var(--ls-accent-text)' }}>{JSON.stringify(name)}: </span>
    );

  return (
    <div>
      <div className="flex items-start gap-1" style={{ minHeight: 26 }}>
        {entries.length > 0 ? (
          <button
            type="button"
            aria-label={`Toggle ${path}`}
            aria-expanded={expanded}
            onClick={() => toggle(path, !expanded)}
            className="inline-flex items-start gap-1 rounded text-left hover:bg-[var(--ls-bg-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ls-accent)]"
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span style={{ overflowWrap: 'anywhere' }}>
              {label}
              {expanded
                ? opening
                : `${opening}…${closing} ${entries.length} ${isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'property' : 'properties'}`}
              {!expanded && !isLast && <span>,</span>}
            </span>
          </button>
        ) : (
          <span style={{ paddingLeft: 20, overflowWrap: 'anywhere' }}>
            {label}
            <span style={{ color: valueColors[typeof value] ?? 'var(--ls-text-3)' }}>
              {isContainer ? `${opening}${closing}` : (JSON.stringify(value) ?? 'null')}
            </span>
            {!isLast && <span>,</span>}
          </span>
        )}
        <JsonCopyButton value={value} path={path} />
      </div>
      {entries.length > 0 && expanded && (
        <div style={{ paddingLeft: 20, borderLeft: '1px solid var(--ls-border-subtle)' }}>
          {entries.map(([key, child], index) => (
            <JsonNode
              key={key}
              name={isArray ? undefined : key}
              isLast={index === entries.length - 1}
              value={child}
              path={`${path}[${JSON.stringify(key)}]`}
              expandedByDefault={expandedByDefault}
              overrides={overrides}
              toggle={toggle}
            />
          ))}
          <div>
            {closing}
            {!isLast && ','}
          </div>
        </div>
      )}
    </div>
  );
};

export const JsonTree = ({ data }: { data: unknown }) => {
  const [expandedByDefault, setExpandedByDefault] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({ $: true });
  const setAll = (expanded: boolean) => {
    setExpandedByDefault(expanded);
    setOverrides({});
  };

  return (
    <section aria-label="Log JSON tree">
      <div className="mb-2 flex gap-2">
        <button type="button" className="ls-imp-btn ls-imp-btn--ghost" onClick={() => setAll(true)}>
          Expand all
        </button>
        <button
          type="button"
          className="ls-imp-btn ls-imp-btn--ghost"
          onClick={() => setAll(false)}
        >
          Collapse all
        </button>
      </div>
      <div
        style={{
          fontFamily: 'var(--ls-font-mono)',
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--ls-text)',
          background: 'var(--ls-panel)',
          border: '1px solid var(--ls-border)',
          borderRadius: 6,
          padding: 10,
          maxHeight: 400,
          overflow: 'auto',
        }}
      >
        <JsonNode
          value={data}
          path="$"
          expandedByDefault={expandedByDefault}
          overrides={overrides}
          toggle={(path, expanded) => setOverrides((prev) => ({ ...prev, [path]: expanded }))}
        />
      </div>
    </section>
  );
};
