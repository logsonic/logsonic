import { getSystemInfo } from '@/lib/api-client';
import { useImportStore } from '@/stores/useImportStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Cloud, File, XCircle } from 'lucide-react';
import { FC, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export const SuccessSummary: FC = () => {
  const {
    selectedFileName,
    importSource,
    sessionOptionsFileName,
    selectedPattern,
    totalLines,
    reset,
    files,
  } = useImportStore();
  const navigate = useNavigate();
  const { setSystemInfo } = useSystemInfoStore();
  const [redirectCounter, setRedirectCounter] = useState(5);
  const searchQueryParamsStore = useSearchQueryParamsStore();

  const isMultiFile = importSource === 'file' && files.length > 0;

  const successFiles = useMemo(() => files.filter(f => f.uploadStatus === 'success'), [files]);
  const failedFiles = useMemo(() => files.filter(f => f.uploadStatus === 'failed'), [files]);
  const totalLinesProcessed = useMemo(
    () => isMultiFile ? files.reduce((sum, f) => sum + f.totalLinesProcessed, 0) : totalLines,
    [isMultiFile, files, totalLines]
  );

  const allSuccess = failedFiles.length === 0;

  useEffect(() => {
    const invalidateInfo = async () => {
      const info = await getSystemInfo(true);
      setSystemInfo(info);
    };
    invalidateInfo();
    searchQueryParamsStore.resetStore();

    const timer = setInterval(() => {
      setRedirectCounter(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          reset();
          navigate('/');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate, setSystemInfo]);

  // Multi-file results
  if (isMultiFile) {
    return (
      <div className="space-y-6 py-4">
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center mb-3">
            {allSuccess ? (
              <CheckCircle className="h-8 w-8 text-green-500 mr-2" />
            ) : (
              <div className="relative mr-2">
                <CheckCircle className="h-8 w-8 text-green-500" />
                <XCircle className="h-4 w-4 text-red-500 absolute -bottom-1 -right-1 bg-white rounded-full" />
              </div>
            )}
            <h2 className="text-2xl font-bold text-gray-800">
              {allSuccess ? 'Import Successful!' : 'Import Complete'}
            </h2>
          </div>
          <p className="text-gray-600 mt-1">
            {allSuccess
              ? `All ${files.length} files have been successfully imported.`
              : `${successFiles.length} of ${files.length} files imported successfully.`
            }
            {' '}Redirecting to home page in {redirectCounter} seconds...
          </p>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto">
          <div className="p-3 rounded-lg border bg-white text-center">
            <p className="text-xl font-bold text-green-600">{successFiles.length}</p>
            <p className="text-xs text-gray-500">Succeeded</p>
          </div>
          {failedFiles.length > 0 && (
            <div className="p-3 rounded-lg border bg-white text-center">
              <p className="text-xl font-bold text-red-500">{failedFiles.length}</p>
              <p className="text-xs text-gray-500">Failed</p>
            </div>
          )}
          <div className="p-3 rounded-lg border bg-white text-center">
            <p className="text-xl font-bold text-gray-800">{totalLinesProcessed.toLocaleString()}</p>
            <p className="text-xs text-gray-500">Lines Processed</p>
          </div>
        </div>

        {/* Per-file results */}
        <div className="border rounded-lg overflow-hidden divide-y bg-white shadow-sm max-w-2xl mx-auto">
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-2.5">
              {f.uploadStatus === 'success' ? (
                <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <File className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-800 truncate">{f.fileName}</span>
                </div>
              </div>
              <Badge variant="outline" className="text-xs flex-shrink-0">
                {f.selectedPattern?.name || 'Unknown'}
              </Badge>
              {f.uploadStatus === 'success' && (
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {f.totalLinesProcessed.toLocaleString()} lines
                </span>
              )}
              {f.uploadStatus === 'failed' && (
                <span className="text-xs text-red-500 flex-shrink-0 truncate max-w-[200px]">
                  {f.uploadError || 'Failed'}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Legacy single-file / CloudWatch results
  const sourceIcon = importSource === 'cloudwatch'
    ? <Cloud className="h-6 w-6 text-blue-500 mr-2" />
    : <File className="h-6 w-6 text-blue-500 mr-2" />;

  const fileLabel = importSource === 'cloudwatch' ? 'CloudWatch Log:' : 'File Name:';
  const fileName = importSource === 'cloudwatch' ? sessionOptionsFileName : selectedFileName;

  return (
    <div className="space-y-6 py-4">
      <div className="flex flex-col items-center text-center">
        <div className="flex items-center mb-3">
          <CheckCircle className="h-8 w-8 text-green-500 mr-2" />
          <h2 className="text-2xl font-bold text-gray-800">Import Successful!</h2>
        </div>
        <p className="text-gray-600 mt-2">
          Your logs have been successfully imported and processed. Redirecting to home page in {redirectCounter} seconds...
        </p>
        <div className="rounded-lg p-6">
          <div className="space-y-2">
            <div className="flex justify-center items-center">
              {sourceIcon}
              <span className="text-gray-600 mr-2">{fileLabel}</span>
              <span className="font-medium">{fileName}</span>
            </div>
            <div className="flex justify-center">
              <span className="text-gray-600 mr-2">Pattern Used: </span>
              <span className="font-medium">{selectedPattern?.name}</span>
            </div>
            <div className="flex justify-center">
              <span className="text-gray-600 mr-2">Total Lines Processed:</span>
              <span className="font-medium">{totalLines.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SuccessSummary;
