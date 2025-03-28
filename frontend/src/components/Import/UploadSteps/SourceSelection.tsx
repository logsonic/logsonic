import { Card } from '@/components/ui/card';
import { LogSourceProvider } from '@/components/Import/types';
import { FC } from 'react';

interface SourceSelectionProps {
  providers: LogSourceProvider[];
  selectedSource: string | null;
  onSelectSource: (source: string) => void;
}

export const SourceSelection: FC<SourceSelectionProps> = ({ 
  providers, 
  selectedSource, 
  onSelectSource 
}) => {
  return (
    <div className="space-y-6">
      <div className="flex flex-col space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">Select Import Source</h2>
        
        <div className="grid grid-cols-2 gap-4">
          {/* Generate provider options dynamically */}
          {providers.map(provider => (
            <div 
              key={provider.id}
              className={`p-4 rounded-lg border-2 flex items-center space-x-3 cursor-pointer transition-colors
                ${selectedSource === provider.id 
                  ? 'border-blue-500 bg-blue-50' 
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}`}
              onClick={() => onSelectSource(provider.id)}
            >
              <div className={`h-5 w-5 rounded-full border flex items-center justify-center 
                ${selectedSource === provider.id ? 'border-blue-500' : 'border-gray-400'}`}>
                {selectedSource === provider.id && (
                  <div className="h-3 w-3 rounded-full bg-blue-500"></div>
                )}
              </div>
              <div className="flex items-center">
                <provider.icon className="h-5 w-5 text-gray-600 mr-2" />
                <span className="font-medium">{provider.name}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      
      {!selectedSource && (
        <div className="text-center p-8 text-gray-500">
          <p>Please select an import source above to continue</p>
        </div>
      )}
    </div>
  );
};

export default SourceSelection; 