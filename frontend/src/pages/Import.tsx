import { useFileSelectionService } from '@/components/Import/LocalFileImport/FileSelectionService';
import HandleNavigation from '@/components/Import/UploadSteps/HandleNavigation';
import { SavePatternDialog } from '@/components/Import/UploadSteps/SavePatternDialog';
import useUpload from '@/components/Import/hooks/useUpload';
import { ErrorBoundary } from '@/lib/error-boundary';
import { ArrowLeft, FileUp } from "lucide-react";
import { FC, Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileAnalyzingStep } from '../components/Import/UploadSteps/FileAnalyzingStep';
import { LogSourceSelectionStep } from '../components/Import/UploadSteps/LogSourceSelectionStep';
import { SuccessSummary } from '../components/Import/UploadSteps/SuccessSummaryStep';
import type { DetectionResult } from '../components/Import/types';
import { extractFields } from '../components/Import/utils/patternUtils';
import { useToast } from "../components/ui/use-toast";
import { getGrokPatterns } from '../lib/api-client';
import { UploadStep, useImportStore } from '../stores/useImportStore';


const Import: FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const {
    importSource,
    reset,
    currentStep,
    readyToSelectPattern,
    setReadyToSelectPattern,
    setImportSource,
    setSelectedPattern,
    setCurrentStep,
    setDetectionResult,
    setAvailablePatterns,
    files,
  } = useImportStore();

  const {
    handleMultiFileUpload,
  } = useUpload();

  const fileService = useFileSelectionService();
  const [showSaveDialogShown, setShowSaveDialogShown] = useState(false);

  const isMultiFile = importSource === 'file' && files.length > 0;

  const steps = [
    { number: 1, label: "Choose Log Source" },
    { number: 2, label: "Define Log Pattern" },
    { number: 3, label: "Summary" }
  ];

  const StepIndicator = ({ number, label, isActive }: { number: number, label: string, isActive: boolean }) => {
    const isCurrentStep = number === currentStep;
    const isComplete = isActive && !isCurrentStep;
    return (
      <div className="flex items-center" style={{ padding: '8px 4px', gap: 10 }}>
        <div
          className="flex items-center justify-center"
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--ls-font-mono)',
            background: isCurrentStep
              ? 'var(--ls-accent)'
              : isComplete
                ? 'var(--ls-accent-soft)'
                : 'var(--ls-bg-2)',
            color: isCurrentStep
              ? '#fff'
              : isComplete
                ? 'var(--ls-accent-text)'
                : 'var(--ls-text-3)',
            border: `1px solid ${isCurrentStep ? 'var(--ls-accent)' : isComplete ? 'var(--ls-accent-border)' : 'var(--ls-border)'}`,
            boxShadow: isCurrentStep ? '0 0 0 4px var(--ls-accent-softer)' : undefined,
            transition: 'all 150ms ease',
          }}
        >
          {number}
        </div>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: isCurrentStep ? 600 : 500,
            color: isCurrentStep
              ? 'var(--ls-text)'
              : isComplete
                ? 'var(--ls-text-2)'
                : 'var(--ls-text-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
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
            description: (p.description && p.description.trim())
              ? p.description
              : `Grok pattern for ${p.name || 'unknown'} logs`,
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

        case 2: {
          const missingPattern = files.find(f => !f.selectedPattern);
          if (missingPattern) {
            toast({
              title: "Pattern Required",
              description: `Please select a pattern for "${missingPattern.fileName}".`,
              variant: "destructive",
            });
            return;
          }

          // Show save dialog if any file uses a custom pattern. Doesn't
          // block the import — the dialog is informational.
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

          setError(null);

          if (files.length === 0) {
            toast({
              title: "Nothing to import",
              description: "Please add at least one file.",
              variant: "destructive",
            });
            return;
          }

          toast({
            title: "Starting import",
            description: `Importing ${files.length} file${files.length !== 1 ? 's' : ''}...`,
          });

          try {
            await handleMultiFileUpload(files, fileService);

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

            setCurrentStep(3);
          } catch (uploadErr) {
            toast({
              title: "Import failed",
              description: uploadErr instanceof Error ? uploadErr.message : "Failed to import files",
              variant: "destructive",
            });
            throw uploadErr;
          }
          break;
        }

        case 3:
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
        reset();
        setCurrentStep(1 as UploadStep);
        break;
    }
  };

  return (
    <ErrorBoundary fallback={<div>Error loading import wizard</div>}>
      <div
        className="min-h-screen"
        style={{ background: 'var(--ls-bg-1)', color: 'var(--ls-text)' }}
      >
        {/* Top bar — mirrors the home Header */}
        <div
          className="flex items-center justify-between"
          style={{
            height: 'var(--ls-topbar-h)',
            padding: '0 14px',
            background: 'var(--ls-panel)',
            borderBottom: '1px solid var(--ls-border)',
          }}
        >
          <div
            className="flex items-center"
            style={{ gap: 6, fontSize: 13, fontWeight: 500 }}
          >
            <span style={{ color: 'var(--ls-text-3)' }}>LogSonic</span>
            <span style={{ color: 'var(--ls-text-4)', margin: '0 6px' }}>/</span>
            <span style={{ color: 'var(--ls-text)' }}>Import</span>
            {isMultiFile && files.length > 0 && currentStep > 1 && (
              <span
                className="inline-flex items-center"
                style={{
                  marginLeft: 8,
                  height: 20,
                  padding: '0 8px',
                  borderRadius: 10,
                  background: 'var(--ls-bg-2)',
                  color: 'var(--ls-text-2)',
                  border: '1px solid var(--ls-border)',
                  fontSize: 11,
                  fontFamily: 'var(--ls-font-mono)',
                }}
              >
                {files.length} file{files.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center transition-colors"
            style={{
              gap: 6,
              height: 28,
              padding: '0 10px',
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid var(--ls-border)',
              color: 'var(--ls-text-2)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ls-bg-2)';
              e.currentTarget.style.color = 'var(--ls-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--ls-text-2)';
            }}
            aria-label="Back to Home"
          >
            <ArrowLeft size={13} />
            <span>Back to home</span>
          </button>
        </div>

        {/* Page header */}
        <div className="w-full mx-auto" style={{ maxWidth: 960, padding: '28px 24px 20px' }}>
          <div className="flex items-center" style={{ gap: 12, marginBottom: 4 }}>
            <div
              className="inline-flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'var(--ls-accent-soft)',
                border: '1px solid var(--ls-accent-border)',
              }}
            >
              <FileUp size={18} style={{ color: 'var(--ls-accent)' }} />
            </div>
            <div>
              <h1
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: 'var(--ls-text)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.2,
                }}
              >
                Import logs
              </h1>
              <p style={{ fontSize: 12, color: 'var(--ls-text-3)', marginTop: 2 }}>
                Bring log files into LogSonic. We'll auto-detect the format.
              </p>
            </div>
          </div>
        </div>

        {/* Wizard panel */}
        <div className="w-full mx-auto" style={{ maxWidth: 960, padding: '0 24px 32px' }}>
          <div
            style={{
              background: 'var(--ls-panel)',
              border: '1px solid var(--ls-border)',
              borderRadius: 'var(--ls-radius-lg)',
              boxShadow: 'var(--ls-shadow-sm)',
              overflow: 'hidden',
            }}
          >
            {/* Step Indicator strip */}
            <div
              className="flex items-center"
              style={{
                padding: '14px 20px',
                background: 'var(--ls-bg-1)',
                borderBottom: '1px solid var(--ls-border)',
              }}
            >
              {steps.map((step, index) => (
                <Fragment key={step.number}>
                  <StepIndicator
                    number={step.number}
                    label={step.label}
                    isActive={currentStep >= step.number}
                  />
                  {index < steps.length - 1 && (
                    <div
                      style={{
                        height: 1,
                        flexGrow: 1,
                        margin: '0 12px',
                        background:
                          currentStep > step.number
                            ? 'var(--ls-accent-border)'
                            : 'var(--ls-border)',
                      }}
                    />
                  )}
                </Fragment>
              ))}
            </div>

            <div style={{ padding: '24px 24px 8px' }}>
              {showSaveDialog && (
                <SavePatternDialog
                  open={showSaveDialog}
                  onClose={() => setShowSaveDialog(false)}
                />
              )}

              {renderCurrentStep()}

              {error && (
                <div
                  className="mt-4"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: 'var(--ls-err-soft)',
                    border: '1px solid color-mix(in srgb, var(--ls-err) 25%, transparent)',
                    color: 'var(--ls-err)',
                    fontSize: 12.5,
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            {/* Footer nav strip */}
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--ls-border)',
                background: 'var(--ls-bg-1)',
              }}
            >
              <HandleNavigation onNext={handleNext} onBack={handleBack} />
            </div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default Import;
