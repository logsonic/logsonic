import { CloudWatchLogProvider } from '@/components/Import/CloudWatchImport/CloudWatchLogProvider';
import { FileSelection } from '@/components/Import/LocalFileImport/FileSelection';
import { useImportStore } from '@/stores/useImportStore';
import { Cloud, FileUp } from 'lucide-react';
import { FC } from 'react';
import SourceSelection from './SourceSelection';

interface LogSourceSelectionStepProps {
  onSourceSelect: (source: string) => void;
  onFileSelect: (filename: string ) => void;
  onFilePreview: (lines: string[], filename: string) => void;
  onBackToSourceSelection: () => void;
}

export const LogSourceSelectionStep: FC<LogSourceSelectionStepProps> = ({
  onSourceSelect,
  onFileSelect,
  onFilePreview,
  onBackToSourceSelection,

}) => {

  const importStore = useImportStore();
  const { importSource } = importStore;

  // When the provider ref is set and ready for analysis, save it to the store
   
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
        component: CloudWatchLogProvider,
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
              onFileSelect={onFileSelect}
              onFilePreview={onFilePreview}
              onBackToSourceSelection={onBackToSourceSelection}
             
          />
        </div>
      )}
    </div>
  );
};

export default LogSourceSelectionStep; 