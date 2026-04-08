import { useCloudWatchLogProviderService } from '@/components/Import/CloudWatchImport/CloudWatchLogProviderService';
import { useFileSelectionService } from '@/components/Import/LocalFileImport/FileSelectionService';
import HandleNavigation from '@/components/Import/UploadSteps/HandleNavigation';
import { SavePatternDialog } from '@/components/Import/UploadSteps/SavePatternDialog';
import useUpload from '@/components/Import/hooks/useUpload';
import { ErrorBoundary } from '@/lib/error-boundary';
import { ArrowLeft, FileUp } from "lucide-react";
import { FC, Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileAnalyzingStep } from '../components/Import/UploadSteps/FileAnalyzingStep';
import { ImportConfirmStep, selectedFileIdsForImport } from '../components/Import/UploadSteps/ImportConfirmStep';
import { LogSourceSelectionStep } from '../components/Import/UploadSteps/LogSourceSelectionStep';
import { SuccessSummary } from '../components/Import/UploadSteps/SuccessSummaryStep';
import type { DetectionResult } from '../components/Import/types';
import { extractFields } from '../components/Import/utils/patternUtils';
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useToast } from "../components/ui/use-toast";
import { getGrokPatterns } from '../lib/api-client';
import { UploadStep, useImportStore } from '../stores/useImportStore';


const Import: FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const {
    selectedPattern,
    importSource,
    reset,
    currentStep,
    readyToImportLogs,
    readyToSelectPattern,
    setReadyToSelectPattern,
    setImportSource,
    setSelectedPattern,
    isCreateNewPatternSelected,
    setCurrentStep,
    setDetectionResult,
    setAvailablePatterns,
    files,
  } = useImportStore();

  const {
    handleUpload,
    handleMultiFileUpload,
  } = useUpload();

  const fileService = useFileSelectionService();
  const cloudWatchService = useCloudWatchLogProviderService();
  const [showSaveDialogShown, setShowSaveDialogShown] = useState(false);

  const isMultiFile = importSource === 'file' && files.length > 0;

  const steps = [
    { number: 1, label: "Choose Log Source" },
    { number: 2, label: "Define Log Pattern" },
    { number: 3, label: "Confirm Import" },
    { number: 4, label: "Summary" }
  ];

  const StepIndicator = ({ number, label, isActive }: { number: number, label: string, isActive: boolean }) => {
    const isCurrentStep = number === currentStep;
    return (
      <div className="flex items-center p-4 rounded-lg">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-xl font-bold ${
          isActive ? 'bg-blue-600' : 'bg-gray-300'
        } ${isCurrentStep ? 'ring-4 ring-blue-200' : ''}`}>
          {number}
        </div>
        <span className={`ml-2 text-md font-medium ${isCurrentStep ? 'text-blue-700' : ''}`}>{label}</span>
      </div>
    );
  };

  // Fetch available patterns on mount
  useEffect(() => {
    const fetchPatterns = async () => {
      try {
        const response = await getGrokPatterns();
        if (response.patterns && response.patterns.length > 0) {
          const patterns = response.patterns.map(p => ({
            name: p.name || 'Unnamed Pattern',
            pattern: p.pattern || '',
            description: p.description || 'No description available',
            custom_patterns: p.custom_patterns,
            fields: extractFields(p.pattern || ''),
            priority: p.priority || 0
          }));
          setAvailablePatterns(patterns);
        }
      } catch (err) {
        console.error('Failed to fetch patterns:', err);
        toast({
          title: "Warning",
          description: "Failed to load patterns from server. Using default patterns instead.",
          variant: "destructive",
        });
      }
    };
    fetchPatterns();
  }, []);

  const handleSourceSelect = (source: string) => {
    console.log(`Source selected: ${source}`);
  };

  const handleFileSelect = (filename: string) => {
    console.log(`File selected: ${filename}`);
  };

  const handleFilePreview = (lines: string[], filename: string) => {
    setReadyToSelectPattern(true);
    setCurrentStep(2);
  };

  const handleBackToSourceSelection = () => {
    setImportSource(null);
  };

  const handleDetectionComplete = (result: DetectionResult) => {
    setDetectionResult(result);

    if (!result.error && result.isOngoing === false && result.suggestedPattern) {
      if (result.suggestedPattern) {
        setSelectedPattern(result.suggestedPattern);
      }
    }
  };

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <LogSourceSelectionStep
            onSourceSelect={handleSourceSelect}
            onFileSelect={handleFileSelect}
            onFilePreview={handleFilePreview}
            onBackToSourceSelection={handleBackToSourceSelection}
          />
        );
      case 2:
        return (
          <FileAnalyzingStep
            onDetectionComplete={handleDetectionComplete}
          />
        );
      case 3:
        return <ImportConfirmStep />;
      case 4:
        return <SuccessSummary />;
      default:
        return null;
    }
  };

  const handleNext = async () => {
    try {
      switch (currentStep) {
        case 1:
          if (!importSource) {
            toast({
              title: "Source Required",
              description: "Please select an import source before proceeding.",
              variant: "destructive",
            });
            return;
          }

          // For multi-file: require at least one file
          if (importSource === 'file' && files.length === 0) {
            toast({
              title: "Files Required",
              description: "Please select at least one log file to import.",
              variant: "destructive",
            });
            return;
          }

          if (readyToSelectPattern || (importSource === 'file' && files.length > 0)) {
            setReadyToSelectPattern(true);
            setCurrentStep(2);
          }
          break;

        case 2:
          // For multi-file: validate all files have patterns
          if (isMultiFile) {
            const missingPattern = files.find(f => !f.selectedPattern);
            if (missingPattern) {
              toast({
                title: "Pattern Required",
                description: `Please select a pattern for "${missingPattern.fileName}".`,
                variant: "destructive",
              });
              return;
            }

            // Show save dialog if any file uses a custom pattern
            if (!showSaveDialogShown) {
              const customPatternFile = files.find(f => f.isCustomPattern && f.selectedPattern);
              if (customPatternFile && customPatternFile.selectedPattern) {
                const store = useImportStore.getState();
                store.setCreateNewPattern(customPatternFile.selectedPattern);
                store.setCreateNewPatternName(customPatternFile.selectedPattern.name);
                store.setCreateNewPatternDescription(customPatternFile.selectedPattern.description || '');
                setShowSaveDialog(true);
                setShowSaveDialogShown(true);
              }
            }

            setCurrentStep(3);
            break;
          }

          // Legacy: sync custom pattern to selectedPattern before proceeding
          if (isCreateNewPatternSelected) {
            const { createNewPattern } = useImportStore.getState();
            setSelectedPattern(createNewPattern);

            if (!showSaveDialogShown) {
              setShowSaveDialog(true);
              setShowSaveDialogShown(true);
            }
          }
          if (readyToImportLogs) {
            setCurrentStep(3);
          }
          break;

        case 3:
          setError(null);

          if (isMultiFile) {
            // Only upload files that are checked in the confirm step
            const checkedIds = selectedFileIdsForImport;
            const filesToImport = checkedIds
              ? files.filter(f => checkedIds.has(f.id))
              : files;

            if (filesToImport.length === 0) {
              toast({
                title: "Nothing to import",
                description: "Please select at least one file.",
                variant: "destructive",
              });
              return;
            }

            // Multi-file upload
            toast({
              title: "Starting import",
              description: `Importing ${filesToImport.length} file${filesToImport.length !== 1 ? 's' : ''}...`,
            });

            try {
              await handleMultiFileUpload(filesToImport, fileService);

              const updatedFiles = useImportStore.getState().files;
              const successCount = updatedFiles.filter(f => f.uploadStatus === 'success').length;
              const failedCount = updatedFiles.filter(f => f.uploadStatus === 'failed').length;

              if (successCount > 0) {
                toast({
                  title: failedCount === 0 ? "Import successful" : "Import complete",
                  description: failedCount === 0
                    ? `All ${successCount} files imported successfully.`
                    : `${successCount} files imported, ${failedCount} failed.`,
                  variant: failedCount === 0 ? "default" : "destructive",
                });
              } else {
                toast({
                  title: "Import failed",
                  description: "All files failed to import.",
                  variant: "destructive",
                });
              }

              setCurrentStep(4);
            } catch (uploadErr) {
              toast({
                title: "Import failed",
                description: uploadErr instanceof Error ? uploadErr.message : "Failed to import files",
                variant: "destructive",
              });
              throw uploadErr;
            }
          } else {
            // Legacy single-file upload
            toast({
              title: "Starting upload process",
              description: "Registering log pattern with the server...",
            });

            try {
              const provider = importSource === 'cloudwatch' ? cloudWatchService : fileService;
              await handleUpload(provider);
              toast({
                title: "Upload successful",
                description: "Your log file has been processed successfully.",
                variant: "default",
              });
              setCurrentStep(4);
            } catch (uploadErr) {
              toast({
                title: "Upload failed",
                description: uploadErr instanceof Error ? uploadErr.message : "Failed to upload file",
                variant: "destructive",
              });
              throw uploadErr;
            }
          }
          break;

        case 4:
          reset();
          navigate('/');
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    }
  };

  const handleBack = () => {
    switch (currentStep) {
      case 1:
        navigate('/');
        break;
      case 2:
        reset();
        setCurrentStep(1 as UploadStep);
        break;
      case 3:
        setCurrentStep(2 as UploadStep);
        break;
      case 4:
        reset();
        setCurrentStep(1 as UploadStep);
        break;
    }
  };

  return (
    <ErrorBoundary fallback={<div>Error loading import wizard</div>}>
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        <div className="w-full mx-auto px-10 py-10">
          {/* Page Header */}
          <div className="flex justify-between items-center mb-8 px-2">
            <div className="flex items-center">
              <FileUp className="h-8 text-blue-600 mr-3" />
              <h1 className="text-xl font-bold text-gray-800">Import Log Wizard</h1>
              {isMultiFile && files.length > 0 && currentStep > 1 && (
                <span className="ml-3 text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => navigate('/')}
              className="flex items-center"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
          </div>

          <Card className="p-10 shadow-md">
            <div className="space-y-6 pb-10">
              {/* Step Indicator */}
              <div className="flex items-center justify-between">
                {steps.map((step, index) => (
                  <Fragment key={step.number}>
                    <StepIndicator
                      number={step.number}
                      label={step.label}
                      isActive={currentStep >= step.number}
                    />
                    {index < steps.length - 1 && (
                      <div className="h-px bg-gray-300 flex-grow mx-2"></div>
                    )}
                  </Fragment>
                ))}
              </div>

              {showSaveDialog && (
                <SavePatternDialog
                  open={showSaveDialog}
                  onClose={() => setShowSaveDialog(false)}
                />
              )}

              {renderCurrentStep()}

              {error && (
                <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
                  {error}
                </div>
              )}

              <HandleNavigation onNext={handleNext} onBack={handleBack} />
            </div>
          </Card>
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default Import;
