import { Check, Copy } from 'lucide-react';
import { FC, useState } from 'react';

/** A path or id shown in mono with a copy button; lifted from the About page for the Storage page. */
export const CopyableValue: FC<{ value: string; maxWidth?: number }> = ({
  value,
  maxWidth = 320,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex items-center" style={{ gap: 6, minWidth: 0 }}>
      <span
        className="ls-mono-inline"
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth }}
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 2,
          color: 'var(--ls-text-3)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {copied ? <Check size={12} style={{ color: 'var(--ls-ok)' }} /> : <Copy size={12} />}
      </button>
    </div>
  );
};
