import { FileSelection } from '@/components/Import/LocalFileImport/FileSelection';
import { useImportStore } from '@/stores/useImportStore';
import { FC, useEffect } from 'react';

interface LogSourceSelectionStepProps {
  onSourceSelect: (source: string) => void;
  onFileSelect: (filename: string) => void;
  onFilePreview: (lines: string[], filename: string) => void;
  onBackToSourceSelection: () => void;
}

export const LogSourceSelectionStep: FC<LogSourceSelectionStepProps> = ({
  onFileSelect,
  onFilePreview,
  onBackToSourceSelection,
}) => {
  const { importSource, setImportSource } = useImportStore();

  // Local-file is currently the only source — set it once on mount so the
  // rest of the wizard (which still keys on importSource) stays happy.
  useEffect(() => {
    if (!importSource) setImportSource('file');
  }, [importSource, setImportSource]);

  return (
    <FileSelection
      onFileSelect={onFileSelect}
      onFilePreview={onFilePreview}
      onBackToSourceSelection={onBackToSourceSelection}
    />
  );
};

export default LogSourceSelectionStep;
