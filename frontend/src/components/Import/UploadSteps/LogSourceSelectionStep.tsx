import { CloudWatchSelection, FileSelection, LogSourceProviderRef } from '@/components/Import/UploadSteps';
import SourceSelection from './SourceSelection';
import ProviderComponent from './ProviderComponent';
import { FC } from 'react';
import { FileUp, Cloud } from 'lucide-react';
import { useImportStore } from '@/stores/useImportStore';
import { LogSourceProvider } from '../types';


interface LogSourceSelectionStepProps {
  providerRef: React.RefObject<LogSourceProviderRef>;
  handleSourceSelect: (source: string) => void;
  handleSourcePreview: (logData: string, filename: string) => void;
  handleBackToSourceSelection: () => void;
}

const LogSourceSelectionStep: FC<LogSourceSelectionStepProps> = ({
  providerRef,
  handleSourceSelect,
  handleSourcePreview,
  handleBackToSourceSelection
}) => {

  const { importSource, setImportSource } = useImportStore();
  // Define available log source providers
  const logSourceProviders: LogSourceProvider[] = [
    {
      id: 'file',
      name: 'Upload Log File',
      icon: FileUp,
      component: FileSelection
    },
    {
      id: 'cloudwatch',
      name: 'AWS CloudWatch Logs',
      icon: Cloud,
      component: CloudWatchSelection
    },
    // Add new providers here in the future (S3, Azure, etc.)
  ];


  return (
    <div className="space-y-6">
     
      <SourceSelection 
        providers={logSourceProviders}
        selectedSource={importSource}
        onSelectSource={handleSourceSelect}
      />
      
      {/* Render the provider component based on the import source */}
      {importSource && (
        <div className="mt-6">
          {(() => {
            const selectedProvider = logSourceProviders.find(p => p.id === importSource);
            if (!selectedProvider) return null;
            
            return (
              <ProviderComponent
                selectedProvider={selectedProvider}
                providerRef={providerRef}
                importSource={importSource}
                handleSourcePreview={handleSourcePreview}
                handleBackToSourceSelection={handleBackToSourceSelection}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default LogSourceSelectionStep; 