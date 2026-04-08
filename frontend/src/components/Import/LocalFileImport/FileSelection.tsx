import { File as FileIcon, Plus, Trash2, Upload } from 'lucide-react';
import { FC, useCallback, useRef, useState } from 'react';
import { useImportStore } from '../../../stores/useImportStore';
import type { LogSourceProvider } from '../types';
import { useFileSelectionService } from './FileSelectionService';

const ACCEPTED_TYPES = ['.log', '.txt', '.json'];
const ACCEPTED_MIME = ['text/plain', 'application/json'];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

function isAcceptedFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  return ACCEPTED_TYPES.includes(ext) || ACCEPTED_MIME.includes(file.type);
}

export const FileSelection: FC<LogSourceProvider> = ({
  onFileSelect,
  onFilePreview,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { error, files, addFiles, removeFile, setMetadata, setSelectedFileName, setSelectedFileHandle, setFilePreviewBuffer } = useImportStore();
  const fileService = useFileSelectionService();
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileErrors, setFileErrors] = useState<string[]>([]);

  const processFiles = useCallback(async (selectedFiles: File[]) => {
    const errors: string[] = [];
    const validFiles: File[] = [];

    // Check for duplicates against existing files
    const existingNames = new Set(files.map(f => f.fileName));

    for (const file of selectedFiles) {
      if (!isAcceptedFile(file)) {
        errors.push(`"${file.name}" is not a supported file type (.log, .txt, .json)`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`"${file.name}" exceeds the 500 MB size limit`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`"${file.name}" is empty`);
        continue;
      }
      if (existingNames.has(file.name)) {
        errors.push(`"${file.name}" is already added`);
        continue;
      }
      existingNames.add(file.name);
      validFiles.push(file);
    }

    setFileErrors(errors);

    if (validFiles.length === 0) return;

    // Add files to the multi-file store
    addFiles(validFiles);

    // For backward compatibility: set the first file as primary
    const primaryFile = files.length === 0 ? validFiles[0] : null;
    if (primaryFile) {
      setMetadata({ _src: `file.${primaryFile.name}` });
      setSelectedFileName(primaryFile.name);
      setSelectedFileHandle(primaryFile);

      await onFileSelect(primaryFile.name);

      // Generate preview for the first file
      await fileService.handleFilePreview(primaryFile, (lines) => {
        if (lines.length > 0) {
          setFilePreviewBuffer({ lines, filename: primaryFile.name });
          onFilePreview(lines, primaryFile.name);
        }
      });
    } else {
      // Files added to existing list, signal readiness
      onFilePreview([], validFiles[0].name);
    }
  }, [files, addFiles, setMetadata, setSelectedFileName, setSelectedFileHandle, setFilePreviewBuffer, fileService, onFileSelect, onFilePreview]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > 0) {
      await processFiles(selectedFiles);
    }
    // Reset input so the same file(s) can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      await processFiles(droppedFiles);
    }
  }, [processFiles]);

  const handleRemoveFile = (fileId: string) => {
    removeFile(fileId);
  };

  const handleAddMoreClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="space-y-4 pt-6 pb-6">
      <h2 className="text-xl font-semibold text-center text-gray-800">
        {files.length === 0 ? 'Import Log Files' : 'Selected Files'}
      </h2>

      {/* Drop zone */}
      <div
        className={`mx-auto w-3/4 border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer
          ${isDragOver
            ? 'border-blue-500 bg-blue-50 scale-[1.01] shadow-lg'
            : files.length > 0
              ? 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
              : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50 shadow-sm hover:shadow-md'
          }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".log,.txt,.json,text/plain,application/json"
          multiple
          onChange={handleFileSelect}
        />

        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-4">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
              <Upload className="h-8 w-8 text-blue-600" />
            </div>
            <span className="text-base font-medium text-gray-700">
              Drop your log files here, or click to browse
            </span>
            <span className="mt-2 text-sm text-gray-500">
              Select one or multiple files (.log, .txt, .json)
            </span>
            <span className="mt-1 text-sm text-gray-400">
              LogSonic will auto-detect the best matching pattern for each file
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-center py-2 text-blue-600">
            <Plus className="h-5 w-5 mr-2" />
            <span className="text-sm font-medium">Add more files</span>
          </div>
        )}
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="mx-auto w-3/4 space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-sm font-medium text-gray-600">
              {files.length} file{files.length !== 1 ? 's' : ''} selected
            </span>
            <button
              onClick={handleAddMoreClick}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add more
            </button>
          </div>

          <div className="border rounded-lg overflow-hidden divide-y bg-white shadow-sm">
            {files.map((importFile, index) => (
              <div
                key={importFile.id}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors group animate-in fade-in slide-in-from-top-1 duration-200"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div className="flex items-center min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center mr-3 flex-shrink-0">
                    <FileIcon className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {importFile.fileName}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatFileSize(importFile.fileSize)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveFile(importFile.id);
                  }}
                  className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all ml-2"
                  title="Remove file"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File validation errors */}
      {fileErrors.length > 0 && (
        <div className="mx-auto w-3/4 bg-amber-50 border border-amber-200 rounded-lg p-3">
          {fileErrors.map((err, i) => (
            <p key={i} className="text-sm text-amber-700 flex items-start">
              <span className="mr-2 mt-0.5 flex-shrink-0">&#x26A0;</span>
              {err}
            </p>
          ))}
        </div>
      )}

      {/* Global error */}
      {error && (
        <div className="mx-auto w-3/4 bg-red-50 border border-red-200 rounded-lg p-4 text-center">
          <span className="text-sm text-red-600">{error}</span>
        </div>
      )}
    </div>
  );
};

export default FileSelection;
