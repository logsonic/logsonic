import { Upload } from 'lucide-react';
import { FC, useRef } from 'react';
import { useImportStore } from '../../../stores/useImportStore';
import type { LogSourceProvider } from '../types';
import { useFileSelectionService } from './FileSelectionService';


export const FileSelection: FC<LogSourceProvider> = ({   
  onFileSelect, 
  onFilePreview,
  onBackToSourceSelection,
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);  
    const { error, setMetadata, setSelectedFileName, setSelectedFileHandle, setFilePreviewBuffer } = useImportStore();
    const fileService = useFileSelectionService();

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        setMetadata({ _src: `file.${file.name}` });
        setSelectedFileName(file.name);
        console.log("Setting selected file handle", file);
        setSelectedFileHandle(file);
        
        await onFileSelect(file.name);

        // Immediately read the first 100 lines of the file
        await fileService.handleFilePreview(file, (lines) => {
          
          if (lines.length > 0) {
            setFilePreviewBuffer({lines, filename: file.name});
            onFilePreview(lines, file.name);
           
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

export default FileSelection; 