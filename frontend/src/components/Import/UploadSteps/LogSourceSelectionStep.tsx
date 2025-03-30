import { CloudWatchSelection, FileSelection, LogSourceProviderRef } from '@/components/Import/UploadSteps';
import SourceSelection from './SourceSelection';
import { FC } from 'react';
import { FileUp, Cloud } from 'lucide-react';
import { useImportStore } from '@/stores/useImportStore';
import { LogSourceProvider } from '../types';


interface LogSourceSelectionStepProps {
  providerRef: React.RefObject<LogSourceProviderRef>;
  onSourceSelect: (source: string) => void;
  onFileSelect: (filename: string ) => void;
  onFilePreview: (logData: string, filename: string) => void;
  onBackToSourceSelection: () => void;
  onFileReadyForAnalysis: (ready: boolean) => void;
}

const LogSourceSelectionStep: FC<LogSourceSelectionStepProps> = ({
  providerRef,
  onSourceSelect,
  onFileSelect,
  onFilePreview,
  onBackToSourceSelection,
  onFileReadyForAnalysis
}) => {

  const { importSource, setImportSource } = useImportStore();

  
    const logSourceProviders: any[] = [ 
      {
        id: 'file',
        name: 'Upload Log File',
        icon: FileUp,
        component: FileSelection,
      },
      {
        id: 'cloudwatch',
        name: 'AWS CloudWatch Logs',  
        icon: Cloud,
        component: CloudWatchSelection,
      }
    ];

  const selectedProvider = importSource 
    ? logSourceProviders.find(p => p.id === importSource)
    : null;

  return (
    <div className="space-y-6">
     
      <SourceSelection 
        providers={logSourceProviders}
        selectedSource={importSource}
        onSelectSource={onSourceSelect} 
      />
      
      {/* Render the provider component based on the import source */}
      {selectedProvider && selectedProvider.component && (
        <div className="mt-6">
          <selectedProvider.component
              ref={providerRef}
              onFileSelect={onFileSelect}
              onFilePreview={onFilePreview}
              onBackToSourceSelection={onBackToSourceSelection}
              onFileReadyForAnalysis={onFileReadyForAnalysis}
          />
        </div>
      )}
    </div>
  );
};

export default LogSourceSelectionStep; 