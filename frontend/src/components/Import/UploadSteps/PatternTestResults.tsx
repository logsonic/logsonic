import { useState, useMemo, FC } from 'react';
import { Loader2, ChevronDown, ChevronRight, ChevronLeft, ArrowRight, ArrowLeft } from 'lucide-react';
import type { PatternTestResultsProps } from '../types';
import { getFieldColors, highlightLogLine } from '../utils/patternUtils';
import StatusBanner from './StatusBanner';
import { useImportStore } from '@/stores/useImportStore';

export const PatternTestResults: FC<Omit<PatternTestResultsProps, 'parsedLogs' | 'isLoading' | 'error'>> = ({
  logs,
  pattern,
  customPatterns
}) => {
  const { parsedLogs, isTestingPattern, error } = useImportStore();
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [showStatusBanner, setShowStatusBanner] = useState(true);
  const [showErrorBanner, setShowErrorBanner] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const logsPerPage = 20;

  // Calculate successful matches (logs without error field)
  const successfulMatches = useMemo(() => {
    if (!parsedLogs) return 0;
    return parsedLogs.filter(log => !log.error).length;
  }, [parsedLogs]);

  const totalPages = Math.ceil(logs.length / logsPerPage);
  const startIndex = currentPage * logsPerPage;
  const endIndex = Math.min(startIndex + logsPerPage, logs.length);
  const currentLogs = logs.slice(startIndex, endIndex);

  const toggleRow = (idx: number) => {
    setExpandedRows(prev => ({
      ...prev,
      [idx + startIndex]: !prev[idx + startIndex]
    }));
  };

  const goToNextPage = () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
      setExpandedRows({});
    }
  };

  const goToPrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
      setExpandedRows({});
    }
  };

  if (isTestingPattern) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-primary mr-3" />
        <span className="text-base text-gray-600">Testing pattern...</span>
      </div>
    );
  }

  if (error && showErrorBanner) {
    return (
      <StatusBanner
        type="error"
        title="Error testing pattern"
        message={error}
        onClose={() => setShowErrorBanner(false)}
      />
    );
  }

  if (!parsedLogs || parsedLogs.length === 0) {
    return (
      <StatusBanner
        type="warning"
        title="No logs were successfully parsed with this pattern."
        onClose={() => setShowStatusBanner(false)}
      />
    );
  }

  // Get only raw fields from the parsed logs
  const allFields = new Set<string>();
  parsedLogs.forEach(log => {
    Object.keys(log).forEach(key => allFields.add(key));
  });
  
  const fieldNames = Array.from(allFields);
  const fieldColors = getFieldColors(fieldNames);

  return (
    <div className="space-y-5 flex flex-col">
      {successfulMatches > 0 && showStatusBanner ? (
        <StatusBanner
          type="success"
          
          title="Pattern test successful!"
          message={`Successfully parsed ${successfulMatches} of ${logs.length} log lines.`}
          onClose={() => setShowStatusBanner(false)}
        />
      ) : successfulMatches === 0 && showStatusBanner ? (
        <StatusBanner
          type="warning"
          title="Pattern test failed!"
          message="No log lines were successfully parsed with this pattern."
          onClose={() => setShowStatusBanner(false)}
        />
      ) : null}
      
      <div className="flex flex-col flex-grow">
        <h3 className="text-lg font-medium p-2">Log Preview</h3>
        <div className="border rounded-md overflow-hidden shadow-sm flex flex-col">
          {/* Table header */}
          <div className="grid grid-cols-[auto_1fr] bg-gray-50 border-b text-sm font-medium text-gray-600">
            <div className="px-4 py-3">Here is how Logsonic will parse your logs. Click on a row to expand it.</div>
          </div>
          
          {/* Scrollable table body */}
          <div className="divide-y overflow-y-auto max-h-[400px]">
            {currentLogs.map((log, idx) => (
              <div key={idx} className="bg-white">
                <div 
                  className="grid grid-cols-[auto_1fr] hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => toggleRow(idx)}
                >
                  <div className="px-4 py-3 font-mono text-sm truncate flex items-center">
                    {expandedRows[idx + startIndex] ? 
                      <ChevronDown className="h-5 w-5 mr-2 flex-shrink-0 text-gray-500" /> : 
                      <ChevronRight className="h-5 w-5 mr-2 flex-shrink-0 text-gray-500" />
                    }
                    {parsedLogs[idx + startIndex] ? (
                      <div className="truncate overflow-hidden">
                        {parsedLogs[idx + startIndex].error ? (
                          <span className="text-gray-400">{log}</span>
                        ) : (
                          highlightLogLine(log, parsedLogs[idx + startIndex])
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">{log}</span>
                    )}
                  </div>
                </div>
                
                {/* Expanded row content */}
                {expandedRows[idx + startIndex] && parsedLogs[idx + startIndex] && (
                  <div className="pl-14 pr-4 py-4 bg-gray-50 border-t">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      {Object.entries(parsedLogs[idx + startIndex]).map(([field, value]) => (
                        <div key={field} className="flex">
                          <span className={`px-2 py-1 rounded mr-3 ${fieldColors[field]}`}>
                            {field}
                          </span>
                          <span className="py-1 text-gray-700 truncate font-mono">
                            {String(value).substring(0, 120)}
                            {String(value).length > 120 ? '...' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          
          {/* Pagination navigation - always visible */}
          <div className="flex justify-between items-center p-3 border-t bg-gray-50">
            <button
              onClick={goToPrevPage}
              disabled={currentPage === 0}
              className={`flex items-center px-3 py-1 rounded border ${
                currentPage === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'
              }`}
            >
             <ArrowLeft className="h-4 w-4 mr-1" />
             
            </button>
            
            <div className="text-sm text-gray-600">
              Showing {startIndex + 1}-{endIndex} of {logs.length} logs
            </div>
            
            <button
              onClick={goToNextPage}
              disabled={currentPage >= totalPages - 1}
              className={`flex items-center px-3 py-1 rounded border ${
                currentPage >= totalPages - 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'
              }`}
            >
              
              <ArrowRight className="h-4 w-4 ml-1" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PatternTestResults; 