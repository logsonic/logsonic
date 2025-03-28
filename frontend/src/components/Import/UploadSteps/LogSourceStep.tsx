import React from 'react';
import { LogSourceProvider } from '@/components/Import/types';
import { LogSourceProviderRef } from '@/components/Import/UploadSteps';
import SourceSelection from './SourceSelection';
import ProviderComponent from './ProviderComponent';

interface LogSourceStepProps {
  providers: LogSourceProvider[];
  importSource: string | null;
  providerRef: React.RefObject<LogSourceProviderRef>;
  handleSourceSelect: (source: string) => void;
  handleFileInputSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleCloudWatchLogSelect: (logData: string, filename: string) => void;
  handleBackToSourceSelection: () => void;
}

const LogSourceStep: React.FC<LogSourceStepProps> = ({
  providers,
  importSource,
  providerRef,
  handleSourceSelect,
  handleFileInputSelect,
  handleCloudWatchLogSelect,
  handleBackToSourceSelection
}) => {
  return (
    <div className="space-y-6">
      <SourceSelection 
        providers={providers}
        selectedSource={importSource}
        onSelectSource={handleSourceSelect}
      />
      
      {importSource && (
        <div className="mt-6">
          {(() => {
            const selectedProvider = providers.find(p => p.id === importSource);
            if (!selectedProvider) return null;
            
            return (
              <ProviderComponent
                selectedProvider={selectedProvider}
                providerRef={providerRef}
                importSource={importSource}
                handleFileInputSelect={handleFileInputSelect}
                handleCloudWatchLogSelect={handleCloudWatchLogSelect}
                handleBackToSourceSelection={handleBackToSourceSelection}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default LogSourceStep; 