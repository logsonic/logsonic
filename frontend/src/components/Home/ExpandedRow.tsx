import { useSearchParser } from '@/hooks/useSearchParser.tsx';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';

interface Log {
  _raw?: string;
  id?: string;
  [key: string]: any;
}
// Simple copy button component
const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded transition-colors"
      style={{ color: 'var(--ls-text-3)' }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ls-accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ls-text-3)')}
      title="Copy to clipboard"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" style={{ color: 'var(--ls-ok)' }} />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
};

/**
 * ExpandedRow component to display log data in a structured format
 */
export const ExpandedRow = ({ data }: { data: Log }) => {
  const [activeTab, setActiveTab] = useState<'raw'|'fields'>('fields');
  const store = useSearchQueryParamsStore();
  const { parseSearchQuery, createHighlighter } = useSearchParser();
  
  // Extract search tokens from the current query
  const searchTokens = useMemo(() => {
    return parseSearchQuery(store.searchQuery || '');
  }, [store.searchQuery, parseSearchQuery]);

  // Create highlighter function
  const highlightText = useMemo(() => {
    return createHighlighter(searchTokens);
  }, [searchTokens, createHighlighter]);
  
  const getFormattedRawLog = () => {
    try {
      // Ensure we get the complete JSON representation of the log
      return JSON.stringify(data, null, 2);
    } catch {
      return data._raw || JSON.stringify(data);
    }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '8px 10px',
    fontSize: 12,
    fontWeight: 500,
    color: active ? 'var(--ls-text)' : 'var(--ls-text-2)',
    borderBottom: `2px solid ${active ? 'var(--ls-accent)' : 'transparent'}`,
    marginBottom: -1,
    background: 'transparent',
    cursor: 'pointer',
  });

  return (
    <div
      style={{
        background: 'var(--ls-bg-1)',
        borderTop: '1px solid var(--ls-border)',
      }}
    >
      {/* Tab bar */}
      <div
        className="flex items-center px-3"
        style={{
          background: 'var(--ls-bg-1)',
          borderBottom: '1px solid var(--ls-border)',
          gap: 2,
        }}
      >
        <button onClick={() => setActiveTab('fields')} style={tabBtn(activeTab === 'fields')}>
          Extracted fields
        </button>
        <button onClick={() => setActiveTab('raw')} style={tabBtn(activeTab === 'raw')}>
          Raw log
        </button>
        <div className="ml-auto">
          <CopyButton content={getFormattedRawLog()} />
        </div>
      </div>

      <div style={{ padding: 12 }}>
        {activeTab === 'raw' && (
          <pre
            className="overflow-x-auto"
            style={{
              fontFamily: 'var(--ls-font-mono)',
              fontSize: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'var(--ls-panel)',
              border: '1px solid var(--ls-border)',
              color: 'var(--ls-text)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 240,
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            {store.searchQuery ? highlightText(getFormattedRawLog()) : getFormattedRawLog()}
          </pre>
        )}

        {activeTab === 'fields' && (
          <div
            style={{
              borderRadius: 6,
              border: '1px solid var(--ls-border)',
              overflow: 'hidden',
              background: 'var(--ls-panel)',
            }}
          >
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <tbody>
                {Object.entries(data)
                  .filter(([key]) => key !== '_raw' && key !== 'id')
                  .map(([key, value]) => {
                    const stringValue = value !== null && value !== undefined
                      ? typeof value === 'object'
                        ? JSON.stringify(value)
                        : String(value)
                      : '-';

                    return (
                      <tr
                        key={key}
                        className="group"
                        style={{ borderTop: '1px solid var(--ls-border-subtle)' }}
                      >
                        <td
                          style={{
                            padding: '5px 10px',
                            width: 160,
                            minWidth: 120,
                            maxWidth: 200,
                            background: 'var(--ls-bg-1)',
                            verticalAlign: 'top',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--ls-font-mono)',
                              fontSize: 11.5,
                              color: 'var(--ls-text-2)',
                            }}
                            title={key}
                          >
                            {key}
                          </span>
                        </td>
                        <td style={{ padding: '5px 10px' }}>
                          <div className="flex items-center justify-between">
                            <code
                              style={{
                                fontFamily: 'var(--ls-font-mono)',
                                fontSize: 12,
                                color: 'var(--ls-text)',
                                wordBreak: 'break-all',
                              }}
                            >
                              {highlightText(stringValue, key)}
                            </code>
                            <button
                              onClick={() => navigator.clipboard.writeText(stringValue)}
                              className="ml-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 grid place-items-center rounded"
                              style={{ width: 16, height: 16, color: 'var(--ls-text-3)' }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'var(--ls-bg-3)';
                                e.currentTarget.style.color = 'var(--ls-accent)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = 'var(--ls-text-3)';
                              }}
                              title="Copy value"
                              aria-label={`Copy value of ${key}`}
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};