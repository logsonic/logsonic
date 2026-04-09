import { useSearchParser } from '@/hooks/useSearchParser.tsx';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
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
    >
      {copied ? (
        <svg className="h-4 w-4 text-green-500" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 8V5.2C8 4.0799 8 3.51984 8.21799 3.09202C8.40973 2.71569 8.71569 2.40973 9.09202 2.21799C9.51984 2 10.0799 2 11.2 2H18.8C19.9201 2 20.4802 2 20.908 2.21799C21.2843 2.40973 21.5903 2.71569 21.782 3.09202C22 3.51984 22 4.0799 22 5.2V12.8C22 13.9201 22 14.4802 21.782 14.908C21.5903 15.2843 21.2843 15.5903 20.908 15.782C20.4802 16 19.9201 16 18.8 16H16M11.2 22H5.2C4.0799 22 3.51984 22 3.09202 21.782C2.71569 21.5903 2.40973 21.2843 2.21799 20.908C2 20.4802 2 19.9201 2 18.8V12.8C2 11.6799 2 11.1198 2.21799 10.692C2.40973 10.3157 2.71569 10.0097 3.09202 9.81801C3.51984 9.60002 4.0799 9.60002 5.2 9.60002H11.2C12.3201 9.60002 12.8802 9.60002 13.308 9.81801C13.6843 10.0097 13.9903 10.3157 14.182 10.692C14.4 11.1198 14.4 11.6799 14.4 12.8V18.8C14.4 19.9201 14.4 20.4802 14.182 20.908C13.9903 21.2843 13.6843 21.5903 13.308 21.782C12.8802 22 12.3201 22 11.2 22Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
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
                            >
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M8 8V5.2C8 4.0799 8 3.51984 8.21799 3.09202C8.40973 2.71569 8.71569 2.40973 9.09202 2.21799C9.51984 2 10.0799 2 11.2 2H18.8C19.9201 2 20.4802 2 20.908 2.21799C21.2843 2.40973 21.5903 2.71569 21.782 3.09202C22 3.51984 22 4.0799 22 5.2V12.8C22 13.9201 22 14.4802 21.782 14.908C21.5903 15.2843 21.2843 15.5903 20.908 15.782C20.4802 16 19.9201 16 18.8 16H16M11.2 22H5.2C4.0799 22 3.51984 22 3.09202 21.782C2.71569 21.5903 2.40973 21.2843 2.21799 20.908C2 20.4802 2 19.9201 2 18.8V12.8C2 11.6799 2 11.1198 2.21799 10.692C2.40973 10.3157 2.71569 10.0097 3.09202 9.81801C3.51984 9.60002 4.0799 9.60002 5.2 9.60002H11.2C12.3201 9.60002 12.8802 9.60002 13.308 9.81801C13.6843 10.0097 13.9903 10.3157 14.182 10.692C14.4 11.1198 14.4 11.6799 14.4 12.8V18.8C14.4 19.9201 14.4 20.4802 14.182 20.908C13.9903 21.2843 13.6843 21.5903 13.308 21.782C12.8802 22 12.3201 22 11.2 22Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
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