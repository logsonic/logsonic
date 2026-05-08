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
      className="p-1.5 text-gray-500 hover:text-gray-700 rounded"
      title="Copy to clipboard"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4" />
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

  return (
    <div className="bg-slate-50/80 border-t border-slate-200">
      {/* Tab bar */}
      <div className="flex items-center border-b border-slate-200 px-3 bg-white">
        <button
          onClick={() => setActiveTab('fields')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === 'fields'
              ? 'text-blue-600 border-blue-500'
              : 'text-slate-500 border-transparent hover:text-slate-700'
          }`}
        >
          Extracted Fields
        </button>
        <button
          onClick={() => setActiveTab('raw')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === 'raw'
              ? 'text-blue-600 border-blue-500'
              : 'text-slate-500 border-transparent hover:text-slate-700'
          }`}
        >
          Raw Log
        </button>
        <div className="ml-auto">
          <CopyButton content={getFormattedRawLog()} />
        </div>
      </div>

      <div className="p-3">
        {activeTab === 'raw' && (
          <pre className="text-xs bg-white p-3 rounded-md border border-slate-200 whitespace-pre-wrap font-mono overflow-x-auto max-h-56 text-slate-800 leading-relaxed">
            {store.searchQuery ? highlightText(getFormattedRawLog()) : getFormattedRawLog()}
          </pre>
        )}

        {activeTab === 'fields' && (
          <div className="rounded-md border border-slate-200 overflow-hidden bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-slate-100">
                {Object.entries(data)
                  .filter(([key]) => key !== '_raw' && key !== 'id')
                  .map(([key, value], index) => {
                    const stringValue = value !== null && value !== undefined
                      ? typeof value === 'object'
                        ? JSON.stringify(value)
                        : String(value)
                      : '-';

                    return (
                      <tr
                        key={key}
                        className="hover:bg-blue-50/40 transition-colors group"
                      >
                        <td className="py-1 px-3 w-[160px] min-w-[120px] max-w-[200px] border-r border-slate-100">
                          <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                            <span className="text-[11px] font-semibold text-slate-600 font-mono truncate" title={key}>
                              {key}
                            </span>
                          </div>
                        </td>
                        <td className="py-1 px-3">
                          <div className="flex items-center justify-between">
                            <code className="text-xs font-mono text-slate-800 break-all">
                              {highlightText(stringValue, key)}
                            </code>
                            <button
                              onClick={() => navigator.clipboard.writeText(stringValue)}
                              className="ml-2 text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
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