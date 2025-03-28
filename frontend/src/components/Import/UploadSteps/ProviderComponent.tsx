import React from 'react';
import { LogSourceProvider } from '@/components/Import/types';
import { CloudWatchSelectionRef, LogSourceProviderRef } from '@/components/Import/UploadSteps';

interface ProviderComponentProps {
  selectedProvider: LogSourceProvider;
  providerRef: React.RefObject<LogSourceProviderRef>;
  importSource: string;
  handleFileInputSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleCloudWatchLogSelect: (logData: string, filename: string) => void;
  handleBackToSourceSelection: () => void;
}

const ProviderComponent: React.FC<ProviderComponentProps> = ({
  selectedProvider,
  providerRef,
  importSource,
  handleFileInputSelect,
  handleCloudWatchLogSelect,
  handleBackToSourceSelection
}) => {
  if (!selectedProvider) return null;
  
  const Component = selectedProvider.component;
  
  // Special handling for each provider type
  if (importSource === 'file') {
    return (
      <Component
        ref={providerRef}
        onFileSelect={handleFileInputSelect}
        onBackToSourceSelection={handleBackToSourceSelection}
      />
    );
  } else if (importSource === 'cloudwatch') {
    return (
      <Component
        ref={providerRef as React.RefObject<CloudWatchSelectionRef>}
        onBackToSourceSelection={handleBackToSourceSelection}
        onCloudWatchLogSelect={handleCloudWatchLogSelect}
      />
    );
  }
  
  // Generic fallback for future providers
  return (
    <Component
      ref={providerRef}
      onBackToSourceSelection={handleBackToSourceSelection}
    />
  );
};

export default ProviderComponent; 