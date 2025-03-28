import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { LogSourceProviderRef } from '@/pages/Import';
import type { FileSelectionProps as OriginalFileSelectionProps } from '../types';
import { useImportStore } from '../../../stores/useImportStore';

// Extend the original props to include the ref
interface FileSelectionProps extends OriginalFileSelectionProps {
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
}

// Forward ref to implement LogSourceProviderRef interface
const FileSelection = forwardRef<LogSourceProviderRef, FileSelectionProps>(
  ({ onFileSelect, onBackToSourceSelection }, ref) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { error, setMetadata } = useImportStore();
    const [pendingResolve, setPendingResolve] = useState<(() => void) | null>(null);

    // Implement the LogSourceProviderRef interface
    useImperativeHandle(ref, () => ({
      handleImport: async () => {
        // Return a promise that will be resolved when a file is selected
        return new Promise<void>((resolve, reject) => {
          // Store the resolve function to call it after file selection
          setPendingResolve(() => resolve);
          
          // Programmatically click the file input
          if (fileInputRef.current) {
            fileInputRef.current.click();
          } else {
            setPendingResolve(null);
            reject(new Error("File input reference is not available"));
          }
        });
      }
    }));

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        setMetadata({ _src: 'file', _file_name: file.name });
      }
      
      // Call the parent's onFileSelect function
      await onFileSelect(event);
      
      // If there's a pending promise resolve, call it
      if (pendingResolve) {
        pendingResolve();
        setPendingResolve(null);
      }
    };

    return (
      <div className="space-y-4 pt-10 pb-10">
        <h2 className="text-2xl font-bold text-center bg-clip-text text-transparent">Import Log File</h2>

        <div className="mx-auto w-1/2 border-2 border-dashed rounded-lg p-6 text-center shadow-sm hover:shadow-md transition-all duration-300">
          <input
            ref={fileInputRef}
            type="file"
            id="file-upload"
            className="hidden"
            accept=".log, .txt, .json, text/plain, application/json"
            onChange={handleFileSelect}
          />
          <label
            htmlFor="file-upload"
            className="flex flex-col items-center justify-center cursor-pointer"
          >
            <Upload className="h-10 w-10 mb-6 text-blue-600" />
            <span className="text-md font-medium">
              Drag and drop your Text Log file here, or click to browse
            </span>
            <span className="mt-6 text-gray-500">
              LogSonic will auto-detect most common log patterns based on the initial file contents. 
            </span>
            <span className="mt-1 text-gray-500">
              You could also define a custom pattern in the next step. 
            </span>
          </label>
        </div>

        {error && (
          <div className="mx-auto w-1/2 border-2 border-dashed rounded-lg p-6 text-center shadow-sm hover:shadow-md transition-all duration-300">
            <span className="text-md font-medium text-red-500">
              {error}
            </span>
          </div>
        )}
      </div>
    );
  }
);

FileSelection.displayName = 'FileSelection';

export default FileSelection; 