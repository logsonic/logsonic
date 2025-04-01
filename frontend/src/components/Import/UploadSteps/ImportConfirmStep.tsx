import { FC, useEffect, useState } from 'react';
import { Progress } from '../../ui/progress';
import { Loader2, FileText, Code, CheckCircle, File, Cloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { useNavigate } from 'react-router-dom';
import { useImportStore } from '@/stores/useImportStore';
import { useCloudWatchStore } from '@/stores/useCloudWatchStore';

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

// Indeterminate oscillator progress for CloudWatch imports
const IndeterminateProgress: FC<{ className?: string }> = ({ className }) => (
  <ProgressPrimitive.Root
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-blue-100",
      className
    )}
  >
    <div 
      className="absolute w-1/3 h-full bg-blue-500 animate-[oscillate_1.5s_ease-in-out_infinite_alternate]"
    />
  </ProgressPrimitive.Root>
);

export const ImportConfirmStep: FC = ({

}) => {
  const { 
    selectedFileName, 
    selectedFileHandle, 
    selectedPattern,
    filePreviewBuffer,
    approxLines, 
    isUploading,    
    uploadProgress,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    importSource,
    sessionOptionsFileName,
    setApproxLines,
    totalLines,
    metadata
  } = useImportStore();

  // Set up a state to track ingested lines that's updated from metadata
  const [ingestedLines, setIngestedLines] = useState(0);
  
  // Update ingested lines based on metadata._total_logs if available
  useEffect(() => {
    if (metadata && typeof metadata._total_logs === 'number') {
      setIngestedLines(metadata._total_logs);
    }
  }, [metadata]);

  const file = selectedFileHandle as File;
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
    (filePreviewBuffer?.lines.length || 0) > 0 ? filePreviewBuffer.lines.length :
    // Fallback: estimate based on file size
    Math.round((file.size || 0) / avgBytesPerLine);

  // If we calculated a new estimate and approxLines was 0, update the store
  useEffect(() => {
    if (approxLines === 0 && estimatedLines > 0) {
      setApproxLines(estimatedLines);
    }
  }, [approxLines, estimatedLines, setApproxLines]);

  // Set the icon, title, and information based on the import source
  const sourceIcon = importSource === 'cloudwatch' 
    ? <Cloud className="h-5 w-5 text-blue-500 mr-2" />
    : <FileText className="h-5 w-5 text-blue-500 mr-2" />;
  
  const sourceTitle = importSource === 'cloudwatch' 
    ? 'CloudWatch Logs Information' 
    : 'File Information';
  
  const fileLabel = importSource === 'cloudwatch' ? 'Source Log:' : 'File Name:';
  const fileName = importSource === 'cloudwatch' ? sessionOptionsFileName : selectedFileName;

  // Determine if we should show the indeterminate progress (for CloudWatch)
  const showIndeterminateProgress = importSource === 'cloudwatch' && isUploading;
  // Determine if we should show the regular progress bar (for file uploads)
  const showProgressBar = importSource !== 'cloudwatch' && isUploading;

  return (
    <div className="space-y-6">
      
      <div className="space-y-4 mx-auto">
        <div className="p-5 rounded-lg shadow-sm border border-blue-100">
          <div className="flex items-center mb-3">
            {sourceIcon}
            <h3 className="text-lg font-medium text-blue-700">{sourceTitle}</h3>
          </div>
          <table className="w-full text-lg">
            <tbody>
              <tr>
                <td className="py-1 text-gray-800 font-bold w-[150px]">{fileLabel}</td>
                <td className="py-1 text-gray-800">{fileName}</td>
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
              <tr>
                <td className="py-1 text-gray-800 font-bold">Metadata:</td>
                
                <td className="py-1 text-gray-800">{JSON.stringify(metadata)}</td>
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
                <td className="py-1 text-gray-800">{selectedPattern?.name}</td>
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
      
      {showProgressBar && (
        <div className="space-y-2 mx-auto w-full rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Uploading...</span>
            <span className="font-medium">{Math.round(uploadProgress)}%</span>
          </div>
          <GreenProgress value={uploadProgress} />
          <div className="flex items-center justify-center text-sm mt-2">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span>Processing file, please wait...</span>
          </div>
        </div>
      )}

      {showIndeterminateProgress && (
        <div className="space-y-2 mx-auto w-full rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Retrieving CloudWatch logs...</span>
            <span className="font-medium">{ingestedLines.toLocaleString()} lines ingested</span>
          </div>
          <IndeterminateProgress />
          <div className="flex items-center justify-center text-sm mt-2">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span>Processing logs, please wait...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImportConfirmStep; 