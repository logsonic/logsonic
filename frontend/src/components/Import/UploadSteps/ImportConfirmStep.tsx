import { useCloudWatchStore } from '@/components/Import/CloudWatchImport/stores/useCloudWatchStore';
import { cn } from '@/lib/utils';
import { useImportStore } from '@/stores/useImportStore';
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { CheckCircle, Cloud, Code, FileText, Loader2, XCircle } from 'lucide-react';
import { FC, useEffect, useState } from 'react';
import type { ImportFile } from '../types';

// Custom progress component with blue indicator
const GreenProgress: FC<{ value: number; className?: string }> = ({
  value,
  className
}) => (
  <ProgressPrimitive.Root
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-blue-100",
      className
    )}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-blue-500 transition-all"
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

// Per-file progress row
const FileProgressRow: FC<{
  file: ImportFile;
  index: number;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ file, index, checked = true, onCheckedChange, disabled = false }) => {
  const isUploading = file.uploadStatus === 'uploading';
  const isSuccess  = file.uploadStatus === 'success';
  const isFailed   = file.uploadStatus === 'failed';
  const isPending  = file.uploadStatus === 'pending';

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={`flex items-center gap-3 px-4 py-3 transition-colors ${
      isUploading ? 'bg-blue-50/60' :
      isSuccess   ? 'bg-green-50/40' :
      isFailed    ? 'bg-red-50/40' :
      !checked    ? 'bg-gray-50 opacity-50' : ''
    }`}>

      {/* Checkbox (pending / pre-upload) or status icon (during/after upload) */}
      <div className="flex-shrink-0 w-5 flex items-center justify-center">
        {isPending ? (
          <Checkbox
            id={`file-check-${file.id}`}
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            className="h-4 w-4"
          />
        ) : isUploading ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        ) : isSuccess ? (
          <CheckCircle className="h-4 w-4 text-green-500" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500" />
        )}
      </div>

      {/* Index */}
      <span className="text-xs text-gray-400 w-4 text-right flex-shrink-0">{index + 1}.</span>

      {/* File name + pattern badge */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <label
            htmlFor={isPending ? `file-check-${file.id}` : undefined}
            className={`text-sm font-medium truncate cursor-pointer ${
              isSuccess ? 'text-green-700' :
              isFailed  ? 'text-red-600' :
              isUploading ? 'text-blue-700' :
              !checked  ? 'text-gray-400' : 'text-gray-800'
            }`}
          >
            {file.fileName}
          </label>
          <Badge
            variant="outline"
            className={`text-xs flex-shrink-0 ${!checked && isPending ? 'opacity-40' : ''}`}
          >
            {file.selectedPattern?.name || 'No pattern'}
          </Badge>
        </div>

        {/* Upload progress bar */}
        {isUploading && (
          <div className="mt-1.5 flex items-center gap-2">
            <GreenProgress value={file.uploadProgress} className="h-1.5 flex-1" />
            <span className="text-xs text-blue-600 w-8 text-right">{Math.round(file.uploadProgress)}%</span>
          </div>
        )}
        {isSuccess && (
          <p className="text-xs text-green-600 mt-0.5">{file.totalLinesProcessed.toLocaleString()} lines processed</p>
        )}
        {isFailed && file.uploadError && (
          <p className="text-xs text-red-500 mt-0.5">{file.uploadError}</p>
        )}
      </div>

      {/* File size */}
      <span className={`text-xs flex-shrink-0 ${!checked && isPending ? 'text-gray-300' : 'text-gray-400'}`}>
        {formatSize(file.fileSize)}
      </span>
    </div>
  );
};


// Export selected file IDs so Import.tsx can read them when triggering upload
export let selectedFileIdsForImport: Set<string> | null = null;

export const ImportConfirmStep: FC = () => {
  const {
    selectedFileName,
    selectedFileHandle,
    selectedPattern,
    filePreviewBuffer,
    approxLines,
    isUploading,
    totalLines,
    uploadProgress,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    importSource,
    setApproxLines,
    metadata,
    files,
  } = useImportStore();

  const isMultiFile = importSource === 'file' && files.length > 0;

  // Track which files are checked for import (all checked by default)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(files.map(f => f.id))
  );

  // Keep the module-level reference in sync so Import.tsx can read it
  selectedFileIdsForImport = checkedIds;

  const toggleFile = (id: string, checked: boolean) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setCheckedIds(checked ? new Set(files.map(f => f.id)) : new Set());
  };

  const file = selectedFileHandle as File;
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const avgBytesPerLine = 120;
  const estimatedLines =
    approxLines > 0 ? approxLines :
    (filePreviewBuffer?.lines.length || 0) > 0 ? filePreviewBuffer.lines.length :
    Math.round((file?.size || 0) / avgBytesPerLine);

  useEffect(() => {
    if (approxLines === 0 && estimatedLines > 0) {
      setApproxLines(estimatedLines);
    }
  }, [approxLines, estimatedLines, setApproxLines]);

  // When files list changes (e.g. navigating back & forward), reset checked state
  useEffect(() => {
    setCheckedIds(new Set(files.map(f => f.id)));
  }, [files.length]);

  const { profile, region } = useCloudWatchStore();

  // Multi-file mode
  if (isMultiFile) {
    const checkedFiles = files.filter(f => checkedIds.has(f.id));
    const totalFileSize = checkedFiles.reduce((sum, f) => sum + f.fileSize, 0);
    const totalApproxLines = checkedFiles.reduce((sum, f) => sum + f.approxLines, 0);
    const successCount = files.filter(f => f.uploadStatus === 'success').length;
    const failedCount = files.filter(f => f.uploadStatus === 'failed').length;
    const uploadingFile = files.find(f => f.uploadStatus === 'uploading');
    const allChecked = files.every(f => checkedIds.has(f.id));
    const someChecked = files.some(f => checkedIds.has(f.id));

    // Overall progress across checked files only
    const overallProgress = checkedFiles.length > 0
      ? checkedFiles.reduce((sum, f) => {
          if (f.uploadStatus === 'success') return sum + 100;
          if (f.uploadStatus === 'uploading') return sum + f.uploadProgress;
          return sum;
        }, 0) / checkedFiles.length
      : 0;

    return (
      <div className="space-y-5">
        {/* Summary stats (selected files only) */}
        {!isUploading && (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border bg-white text-center">
              <p className="text-2xl font-bold text-gray-800">{checkedFiles.length}</p>
              <p className="text-sm text-gray-500">
                {checkedFiles.length === files.length ? 'Files' : `of ${files.length} Files`}
              </p>
            </div>
            <div className="p-4 rounded-lg border bg-white text-center">
              <p className="text-2xl font-bold text-gray-800">{formatFileSize(totalFileSize)}</p>
              <p className="text-sm text-gray-500">Total Size</p>
            </div>
            <div className="p-4 rounded-lg border bg-white text-center">
              <p className="text-2xl font-bold text-gray-800">
                ~{totalApproxLines > 0 ? totalApproxLines.toLocaleString() : '—'}
              </p>
              <p className="text-sm text-gray-500">Est. Lines</p>
            </div>
          </div>
        )}

        {/* Overall progress when uploading */}
        {isUploading && (
          <div className="p-4 rounded-lg border bg-white space-y-2">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                <span className="font-medium text-gray-700">
                  Importing {uploadingFile ? `"${uploadingFile.fileName}"` : ''}...
                </span>
              </div>
              <span className="text-gray-500">
                {successCount} / {checkedFiles.length} files complete
              </span>
            </div>
            <GreenProgress value={overallProgress} />
          </div>
        )}

        {/* File list with checkboxes / per-file status */}
        <div className="border rounded-lg overflow-hidden divide-y bg-white shadow-sm">
          {/* Header with select-all */}
          <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center gap-3">
            {!isUploading && (
              <Checkbox
                id="select-all"
                checked={allChecked}
                onCheckedChange={(v) => toggleAll(!!v)}
                className="h-4 w-4"
              />
            )}
            <label
              htmlFor={!isUploading ? 'select-all' : undefined}
              className="text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none"
            >
              Files to Import
            </label>
            {!isUploading && someChecked && !allChecked && (
              <span className="text-xs text-blue-600 ml-auto">{checkedIds.size} selected</span>
            )}
          </div>

          {files.map((f, i) => (
            <FileProgressRow
              key={f.id}
              file={f}
              index={i}
              checked={checkedIds.has(f.id)}
              onCheckedChange={(v) => toggleFile(f.id, !!v)}
              disabled={isUploading}
            />
          ))}
        </div>

        {/* Errors summary */}
        {failedCount > 0 && !isUploading && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100">
            <p className="text-sm text-red-700 font-medium">
              {failedCount} file{failedCount !== 1 ? 's' : ''} failed to import
            </p>
          </div>
        )}

        {/* Nothing selected warning */}
        {!isUploading && checkedIds.size === 0 && (
          <div className="p-3 bg-amber-50 rounded-lg border border-amber-100">
            <p className="text-sm text-amber-700">Select at least one file to import.</p>
          </div>
        )}
      </div>
    );
  }

  // --- Legacy single-file / CloudWatch mode ---

  const sourceIcon = importSource === 'cloudwatch'
    ? <Cloud className="h-5 w-5 text-blue-500 mr-2" />
    : <FileText className="h-5 w-5 text-blue-500 mr-2" />;

  const sourceTitle = importSource === 'cloudwatch'
    ? 'CloudWatch Logs Information'
    : 'File Information';

  const showIndeterminateProgress = importSource === 'cloudwatch' && isUploading;
  const showProgressBar = importSource !== 'cloudwatch' && isUploading;

  return (
    <div className="space-y-6">
      <div className="space-y-4 mx-auto">
        <div className="p-5 rounded-lg shadow-sm border border-blue-100">
          <div className="flex items-center mb-3">
            {sourceIcon}
            <h3 className="text-md font-medium text-blue-700">{sourceTitle}</h3>
          </div>
          <table className="text-md w-full">
            <thead>
              <tr>
                <th className="w-[250px] text-gray-800 font-bold text-left">Key</th>
                <th className="text-gray-800 font-bold text-left">Value</th>
              </tr>
            </thead>
            <tbody>
              {importSource === 'cloudwatch' && (
                <>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">CloudWatch Region:</td>
                    <td className="py-1 text-gray-800">{region}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">CloudWatch Profile:</td>
                    <td className="py-1 text-gray-800">{profile}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">CloudWatch Stream name:</td>
                    <td className="py-1 text-gray-800">{selectedFileName}</td>
                  </tr>
                </>
              )}
              {importSource === 'file' && (
                <>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">File Name:</td>
                    <td className="py-1 text-gray-800">{selectedFileName}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">File Size:</td>
                    <td className="py-1 text-gray-800">{file ? formatFileSize(file.size) : 'N/A'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-gray-800 font-bold">Total Lines:</td>
                    <td className="py-1 text-gray-800">{approxLines.toLocaleString()} lines estimated</td>
                  </tr>
                </>
              )}
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

        <div className="p-5 rounded-lg shadow-sm border border-indigo-100">
          <div className="flex items-center mb-3">
            <Code className="h-5 w-5 text-indigo-500 mr-2" />
            <h3 className="text-md font-medium text-indigo-700">Pattern Information</h3>
          </div>
          <table className="w-full text-md">
            <thead>
              <tr>
                <th className="w-[250px] text-gray-800 font-bold text-left">Key</th>
                <th className="text-gray-800 font-bold text-left">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1 text-gray-800 font-bold w-[150px]">Pattern Name:</td>
                <td className="py-1 text-gray-800">{selectedPattern?.name}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Description:</td>
                <td className="py-1 text-gray-800">{selectedPattern?.description}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Priority:</td>
                <td className="py-1 text-gray-800">{selectedPattern?.priority}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-800 font-bold">Extracted Fields:</td>
                <td className="py-1 text-gray-800">{selectedPattern?.fields?.join(', ')}</td>
              </tr>
            </tbody>
          </table>

          <div className="mt-3">
            <div className="py-1 text-gray-800 font-bold">Pattern:</div>
            <div className="bg-white p-2 text-sm rounded font-mono overflow-x-auto border">
              {selectedPattern?.pattern}
            </div>
          </div>

          {selectedPattern?.custom_patterns && Object.keys(selectedPattern.custom_patterns).length > 0 && (
            <div className="mt-3">
              <div className="py-1 text-gray-800 font-bold">Custom Patterns:</div>
              <table className="w-full bg-white rounded border shadow-inner font-mono">
                <tbody>
                  {Object.entries(selectedPattern.custom_patterns).map(([name, pattern]) => (
                    <tr key={name}>
                      <td className="p-1 border-b border-indigo-50 w-[150px] whitespace-nowrap">{name}:</td>
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
            <span className="font-medium">{totalLines.toLocaleString()} lines ingested</span>
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
