import React from 'react';
import { Upload, Cloud } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface SourceSelectionProps {
  onSelectSource: (source: 'file' | 'cloudwatch') => void;
}

export const SourceSelection: React.FC<SourceSelectionProps> = ({ onSelectSource }) => {
  return (
    <div className="space-y-6 pt-10 pb-10">
      <h2 className="text-2xl font-bold text-center">Select Import Source</h2>
      
      <div className="grid grid-cols-2 gap-6 mt-8">
        {/* File Upload Option */}
        <Card 
          className="p-6 cursor-pointer border-2 hover:border-blue-400 hover:shadow-md transition-all duration-300"
          onClick={() => onSelectSource('file')}
        >
          <div className="flex flex-col items-center text-center h-full justify-center py-8">
            <Upload className="h-12 w-12 mb-4 text-blue-600" />
            <h3 className="text-lg font-medium mb-2">File Upload</h3>
            <p className="text-gray-500 text-sm">
              Import logs from a local text file
            </p>
          </div>
        </Card>
        
        {/* CloudWatch Option */}
        <Card 
          className="p-6 cursor-pointer border-2 hover:border-blue-400 hover:shadow-md transition-all duration-300"
          onClick={() => onSelectSource('cloudwatch')}
        >
          <div className="flex flex-col items-center text-center h-full justify-center py-8">
            <Cloud className="h-12 w-12 mb-4 text-blue-600" />
            <h3 className="text-lg font-medium mb-2">AWS CloudWatch</h3>
            <p className="text-gray-500 text-sm">
              Import logs from AWS CloudWatch
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SourceSelection; 