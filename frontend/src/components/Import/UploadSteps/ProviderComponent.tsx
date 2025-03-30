import { LogSourceProvider } from '@/components/Import/types';
import { CloudWatchSelectionRef, LogSourceProviderRef } from '@/components/Import/UploadSteps';
import { FC } from 'react';

interface ProviderComponentProps {
  selectedProvider: LogSourceProvider;
  providerRef: React.RefObject<LogSourceProviderRef>;
  importSource: string;
  handleSourcePreview: (logData: string, filename: string) => void;
  handleBackToSourceSelection: () => void;
}

// ProviderComponent is a component that renders a provider component based on the import source
// This should abstract away any specific provider logic and just expose the source preview and back to source selection
const ProviderComponent: FC<ProviderComponentProps> = ({
  selectedProvider,
  providerRef,
  importSource,
  handleSourcePreview,
  handleBackToSourceSelection
}) => {
  if (!selectedProvider) return null;
  
  const Component = selectedProvider.component;
  
  // Special handling for each provider type
  if (importSource === 'file') {
    return (
      <Component
        ref={providerRef}
        onSourcePreview={handleSourcePreview}
        onBackToSourceSelection={handleBackToSourceSelection}
      />
    );
  } else if (importSource === 'cloudwatch') {
    return (
      <Component
        ref={providerRef as React.RefObject<CloudWatchSelectionRef>}
        onBackToSourceSelection={handleBackToSourceSelection}
        onSourcePreview={handleSourcePreview}
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