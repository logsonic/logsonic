import { FC, useEffect } from 'react';
import { Progress } from '../../../components/ui/progress';
import { Loader2, FileText, Code, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { useImportStore } from '@/stores/useImportStore';

// Success Summary component for showing import completion
export const SuccessSummary: FC<{
  uploadSummary: {
    totalLines: number;
    patternName: string;
    redirectCountdown: number;
  };
}> = ({ uploadSummary }) => {
  const { selectedFile } = useImportStore();

  return (
    <div className="space-y-6 py-4">
      <div className="flex flex-col items-center text-center">
        <div className="flex items-center mb-3">
          <CheckCircle className="h-8 w-8 text-green-500 mr-2" />
          <h2 className="text-2xl font-bold text-gray-800">Import Successful!</h2>
        </div>
        <p className="text-gray-600 mt-2">
          Your logs have been successfully imported and processed. Redirecting to home page in {uploadSummary.redirectCountdown} seconds...
        </p>
        <div className="rounded-lg p-6">
        <div className="space-y-2">
          <div className="flex justify-center">
            <span className="text-gray-600 mr-2">File Name: </span>
            <span className="font-medium">{selectedFile?.name}</span>
          </div>
          <div className="flex justify-center">
            <span className="text-gray-600 mr-2">Pattern Used: </span>
            <span className="font-medium">{uploadSummary.patternName}</span>
          </div>
          <div className="flex justify-center">
            <span className="text-gray-600 mr-2">Total Lines Processed:</span>
            <span className="font-medium">{uploadSummary.totalLines.toLocaleString()}</span>
          </div>
        </div>
      </div>
      </div>
      

      
      <div className="text-center text-gray-500 mt-4">
       
      </div>
    </div>
  );
};

// Custom progress component with green indicator
const GreenProgress: FC<{ value: number; className?: string }> = ({ 
  value, 
  className 
}) => (
  <ProgressPrimitive.Root
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-green-100",
      className
    )}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-green-500 transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
);

export const ImportConfirm: FC = ({

}) => {
  const { 
    selectedFile, 
    selectedPattern, 
    filePreview,
    approxLines, 
    isUploading, 
    uploadProgress,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    setApproxLines
  } = useImportStore();

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Use filePreview.totalLines if available, or calculate approx lines if approxLines is 0
  // Average bytes per line depends on the log format - we use 120 as a reasonable average
  const avgBytesPerLine = 120;
  const estimatedLines = 
    // First priority: use approxLines if it's already set
    approxLines > 0 ? approxLines :
    // Second priority: use filePreview.totalLines if available
    (filePreview?.totalLines || 0) > 0 ? filePreview.totalLines :
    // Fallback: estimate based on file size
    Math.round((selectedFile?.size || 0) / avgBytesPerLine);

  // If we calculated a new estimate and approxLines was 0, update the store
  useEffect(() => {
    if (approxLines === 0 && estimatedLines > 0) {
      setApproxLines(estimatedLines);
    }
  }, [approxLines, estimatedLines, setApproxLines]);

  return (
    <div className="space-y-6">
      
      <div className="space-y-4 mx-auto">
        <div className="p-5 rounded-lg shadow-sm border border-blue-100">
          <div className="flex items-center mb-3">
            <FileText className="h-5 w-5 text-blue-500 mr-2" />
            <h3 className="text-lg font-medium text-blue-700">Importing File Information</h3>
          </div>
          <table className="w-full text-lg">
            <tbody>
              <tr>
                <td className="py-1 text-gray-800 font-bold w-[150px]">File Name:</td>
                <td className="py-1  text-gray-800">{selectedFile?.name}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">File Size:</td>
                <td className="py-1  text-gray-800">{formatFileSize(selectedFile?.size || 0)}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Estimated Lines:</td>
                <td className="py-1 text-gray-800">{estimatedLines.toLocaleString()} approximate lines</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Smart Decoder:</td>
                <td className="py-1 text-gray-800">{sessionOptionsSmartDecoder ? 'Yes' : 'No'}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Force Timezone:</td>
                <td className="py-1 text-gray-800">{sessionOptionsTimezone || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Force Year:</td>
                <td className="py-1 text-gray-800">{sessionOptionsYear || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Force Month:</td>
                <td className="py-1 text-gray-800">{sessionOptionsMonth || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Force Day:</td>
                <td className="py-1 text-gray-800">{sessionOptionsDay || 'Auto-detect'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        
        <div className=" p-5 rounded-lg shadow-sm border border-indigo-100">
          <div className="flex items-center mb-3">
            <Code className="h-5 w-5 text-indigo-500 mr-2" />
            <h3 className="text-lg font-medium text-indigo-700">Pattern Information</h3>
          </div>
          <table className="w-full text-lg">
            <tbody>
              <tr>
                <td className="py-1 text-gray-800 font-bold  w-[150px]">Pattern Name:</td>
                <td className="py-1 text-gray-800">{selectedPattern.name}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Description:</td>
                <td className="py-1 text-gray-800">{selectedPattern.description}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Priority:</td>
                <td className="py-1 text-gray-800">{selectedPattern.priority}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Extracted Fields:</td>
                <td className="py-1 text-gray-800">{selectedPattern.fields.join(', ')}</td>
              </tr>
              
            </tbody>
          </table>
          
          <div className="mt-3">
            <div className="py-1 text-gray-800 font-bold">Pattern:</div>
            <div className="bg-white p-2 text-sm rounded  font-mono overflow-x-auto border">
              {selectedPattern.pattern}
            </div>
          </div>
          
          {selectedPattern.custom_patterns && Object.keys(selectedPattern.custom_patterns).length > 0 && (
            <div className="mt-3">
              <div className="py-1 text-gray-800 font-bold">Custom Patterns:</div>
              <table className="w-full bg-white rounded border shadow-inner font-mono">
                <tbody>
                  {Object.entries(selectedPattern.custom_patterns).map(([name, pattern]) => (
                    <tr key={name}>
                      <td className="p-1 border-b border-indigo-50  w-[150px] whitespace-nowrap">{name}:</td>
                      <td className="p-1 border-b border-indigo-50 overflow-x-auto text-justify-left">{pattern}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      
      {isUploading && (
        <div className="space-y-2 mx-auto w-full rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Uploading...</span>
            <span className="font-medium ">{Math.round(uploadProgress)}%</span>
          </div>
          <GreenProgress value={uploadProgress} />
          <div className="flex items-center justify-center text-sm mt-2">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span>Processing file, please wait...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImportConfirm; 