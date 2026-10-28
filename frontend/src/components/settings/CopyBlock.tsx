import { Check, Copy } from 'lucide-react';
import { FC, useState } from 'react';

/** A labelled code block with a copy button (MCP Integration, Agent settings). */
export const CopyBlock: FC<{ label: string; value: string }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 6, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ls-text-2)' }}>{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center"
          style={{
            gap: 4,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
            color: copied ? 'var(--ls-ok)' : 'var(--ls-text-3)',
            padding: '2px 4px',
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 14px',
          background: 'var(--ls-bg-2)',
          border: '1px solid var(--ls-border)',
          borderRadius: 'var(--ls-radius)',
          fontSize: 12,
          fontFamily: 'var(--ls-font-mono)',
          color: 'var(--ls-text)',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {value}
      </pre>
    </div>
  );
};
