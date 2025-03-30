import { forwardRef, useImperativeHandle, useRef, useState, FC } from 'react';
import { Upload } from 'lucide-react';
import type { LogSourceProvider, LogSourceProviderService } from '../types';
import { useImportStore } from '../../../stores/useImportStore';


export const FileSelectionService : LogSourceProviderService = {
  name: "File",

  handleFilePreview: async (file, onPreviewReadyCallback) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').slice(0, 100);

      // TBD check if the file is binary or has no valid delimiter
      onPreviewReadyCallback(lines);
      reader.abort();
    };
    reader.readAsText(file);
  },
  handleFileImport: (filename, filehandle, chunkSize, callback) => {  
    // process data

    let currentIndex = 0;
    return new Promise((resolve, reject) => {
      console.log("Importing file:", filename, "with handle:", filehandle);
      if (filename && filehandle) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const text = e.target?.result as string;
          const lines = text.split('\n');
          let totalLines = lines.length;

          const processChunk = async () => {
            const chunk = lines.slice(currentIndex, currentIndex + chunkSize);
            await callback(chunk, totalLines, () => {
              currentIndex += chunkSize;
              if (currentIndex < totalLines) {
                processChunk();
              } else {
                resolve();
              }
            });
          };  
          processChunk();
        };
        reader.onerror = (e) => {
          reject(new Error("Error reading file"));
        };
        reader.readAsText(filehandle);
      } else {
        reject(new Error("No filename or filehandle provided"));
      }
    });
  },
};
// Forward ref 
const FileSelection = forwardRef<{}, LogSourceProvider>(({   
  onFileSelect, 
  onFilePreview,
  onBackToSourceSelection,
  onFileReadyForAnalysis
}, ref) => {
    const fileInputRef = useRef<HTMLInputElement>(null);  
    const { error, setMetadata, setSelectedFileName, setSelectedFileHandle } = useImportStore();
    const [pendingResolve, setPendingResolve] = useState<(() => void) | null>(null);

    // Implement the LogSourceProviderRef interface
    useImperativeHandle(ref, () => ({
      handleImport: async (chunkSize, callback) => {
        // Implementation
      },
      getName: () => {
        // Return the filename of the selected file
        return fileInputRef.current?.files?.[0]?.name || 'Unknown file';
      }
    }));

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        setMetadata({ _src: `file.${file.name}` });
        setSelectedFileName(file.name);
        setSelectedFileHandle(file);
        await onFileSelect(file.name);

        // Immediately read the first 100 lines of the file
        await FileSelectionService.handleFilePreview(file, (lines) => {
          
          if (lines.length > 0) {
            onFilePreview(lines.join('\n'), file.name);
            onFileReadyForAnalysis(true);
          }
        });
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