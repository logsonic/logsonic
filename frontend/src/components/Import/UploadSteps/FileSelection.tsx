import { Upload } from 'lucide-react';
import type { FileSelectionProps } from '../types';
import { FC } from 'react';
import { useImportStore } from '../../../stores/useImportStore';

export const FileSelection: FC<FileSelectionProps> = ({ onFileSelect }) => {
  const { error } = useImportStore();
  return (
    <div className="space-y-4 pt-10 pb-10">
      <h2 className="text-2xl font-bold text-center bg-clip-text text-transparent">Import Log File</h2>

      
      <div className="mx-auto w-1/2 border-2 border-dashed rounded-lg p-6 text-center shadow-sm hover:shadow-md transition-all duration-300">
        <input
          type="file"
          id="file-upload"
          className="hidden"
          onChange={onFileSelect}
        />
        <label
          htmlFor="file-upload"
          className="flex flex-col items-center justify-center cursor-pointer"
        >
          <Upload className="h-10 w-10 mb-6 text-blue-600" />
          <span className="text-md font-medium">
            Drag and drop your Text Log file here, or click to browse
          </span>
          <span className="mt-6  text-gray-500">
            LogSonic will auto-detect most common log patterns based on the initial file contents. 
          </span>
          <span className="mt-1  text-gray-500">
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
};

export default FileSelection; 