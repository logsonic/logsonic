import { FC, Fragment, useEffect, useRef, useState } from 'react';  
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ArrowLeft, ArrowRight, CheckCircle, Store, FileUp, Cloud } from "lucide-react";
import { 
  FileSelection, 
  FileAnalyzing,      
  ImportConfirm,
  SuccessSummary,
  LogSourceStep,
} from '../components/Import/UploadSteps';
import { useUpload } from '../components/Import/hooks';
import type { Pattern, DetectionResult, LogSourceProvider } from '../components/Import/types';
import { LogSourceProviderRef } from '../components/Import/types';
import { useToast } from "../components/ui/use-toast";
import { clearTokenizer, getGrokPatterns, getSystemInfo } from '../lib/api-client';
import { extractFields } from '../components/Import/utils/patternUtils';
import { useImportStore, UploadStep, DEFAULT_PATTERN } from '../stores/useImportStore';
import { useNavigate } from 'react-router-dom';
import { useSearchQueryParamsStore } from '../stores/useSearchParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { CloudWatchSelection, useCloudWatchStore } from '@/components/CloudWatch';
import type { CloudWatchSelectionRef } from '@/components/CloudWatch';

// Define the interface in types/index.ts, then re-export from UploadSteps/index.ts
// We should eventually remove this from here

const Import: FC  = () => {
  const { toast } = useToast(); 
  const navigate = useNavigate();
  const searchQueryParamsStore = useSearchQueryParamsStore();

  const [error, setError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{
    totalLines: number;
    patternName: string;
    redirectCountdown: number;
    showSummary: boolean;
  } | null>(null);
  const [redirectTimer, setRedirectTimer] = useState<NodeJS.Timeout | null>(null);
  const { setSystemInfo } = useSystemInfoStore();
  const [showSavePatternDialog, setShowSavePatternDialog] = useState(false);

  // Define steps data
  const steps = [
    { number: 1, label: "Choose Log Source" },
    { number: 2, label: "Define Log Pattern" },
    { number: 3, label: "Confirm Import" }
  ];

  // Step indicator component
  const StepIndicator = ({ number, label, isActive }: { number: number, label: string, isActive: boolean }) => {
    const isCurrentStep = number === importStore.currentStep;
    
    return (
      <div className={`flex items-center p-4 rounded-lg `}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-xl font-bold ${
          isActive ? 'bg-blue-600' : 'bg-gray-300'
        } ${isCurrentStep ? 'ring-4 ring-blue-200' : ''}`}>
          {number}
        </div>
        <span className={`ml-2 text-md font-medium ${isCurrentStep ? 'text-blue-700' : ''}`}>{label}</span>
      </div>
    );
  };

  const importStore = useImportStore();
  const {
    selectedFile,
    filePreview,
    readyToSelectPattern,
    selectedPattern,
    importSource,
    handleFileSelect,
    setFileFromBlob,
    setImportSource,
    setSelectedPattern,
    setFilePreview,
    currentStep,
    setCurrentStep,
    detectionResult,
    setDetectionResult,
    createNewPattern
  } = importStore;

  // Generic reference for the current log provider component
  const logProviderRef = useRef<LogSourceProviderRef>(null);

  // Internal common handler function
  const processLogData = (logData: string, filename: string) => {
    setFileFromBlob(logData, filename);
    console.log(`Logs selected from ${importSource}, advancing to step 2`);
  };

  // Type-specific handler for file selection events
  const handleFileInputSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // Call the original handleFileSelect for file selection logic
    await handleFileSelect(event);
  };
  
  // Type-specific handler for CloudWatch log selection
  const handleCloudWatchLogSelect = (logData: string, filename: string) => {
    processLogData(logData, filename);
  };

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

  // Reset the import store when the component mounts
  useEffect(() => {
    // Reset the store to default values on first load
    importStore.reset();
    
    // Clear any existing redirect timer when component unmounts
    return () => {
      if (redirectTimer) {
        clearInterval(redirectTimer);
      }
    };
  }, []);

  const {
    isUploading,
    uploadProgress,
    approxLines,
    handleUpload,
  } = useUpload();

  // Fetch available patterns from the server on component mount
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
          importStore.setAvailablePatterns(patterns);
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

  // Set default date range values in useEffect to avoid state updates during render
  useEffect(() => {
    // Only set date range if CloudWatch source is selected and store exists
    if (importSource === 'cloudwatch') {
      setTimeout(() => {
        const store = useSearchQueryParamsStore.getState();
        store.isRelative = true;
        store.relativeValue = '24h';
        console.log(`Default date range set to last 24 hours for CloudWatch`);
      }, 0);
    }
  }, [importSource]);

  // Function to handle pattern save dialog close
  const handleSavePatternDialogClose = () => {
    setShowSavePatternDialog(false);
    // Now proceed to step 3
    setCurrentStep(3);
  };

  // Handle source selection
  const handleSourceSelect = (source: string) => {
    setImportSource(source);
  };

  // Handle back button for any provider
  const handleBackToSourceSelection = () => {
    setImportSource(null);
  };

  // Handle Next button press
  const handleNext = async () => {
    try {
      switch (currentStep) {
        case 1:
          // If source is not selected yet, don't proceed
          if (!importSource) {
            toast({
              title: "Source Required",
              description: "Please select an import source before proceeding.",
              variant: "destructive",
            });
            return;
          }
          
          // Provider-agnostic validation - ask the provider if we can proceed
          if (logProviderRef.current) {
            const { canProceed, errorMessage } = await logProviderRef.current.validateCanProceed();
            
            if (!canProceed) {
              toast({
                title: "Validation Failed",
                description: errorMessage || "Cannot proceed. Please check your selection.",
                variant: "destructive",
              });
              return;
            }
            
            // For non-file providers that need their own import handling
            if (importSource !== 'file') {
              console.log(`Importing logs from ${importSource}`);
              
              try {
                await logProviderRef.current.handleImport();
                // The provider will update importStore state as needed
                return; // Exit early since the component handles next step
              } catch (importErr) {
                console.error(`Failed to import logs from ${importSource}:`, importErr);
                toast({
                  title: "Import Failed",
                  description: `Failed to import logs from ${importSource}. Please try again.`,
                  variant: "destructive",
                });
                return;
              }
            }
          }
          
          // Set current step to 2 (pattern detection)
          console.log(`Advancing to step 2 with import source: ${importSource}`);
          setCurrentStep(2);
          break;
        case 2:
          // Check if there's a custom pattern that needs to be saved
          if (detectionResult?.isOngoing === false) {
            console.log("Step 2 Next button clicked - manually advancing to step 3");
            // If user created a custom pattern, show save dialog first
            if (importStore.isCreateNewPatternSelected) {
              console.log("Custom pattern selected, showing save dialog before step 3");
              setShowSavePatternDialog(true);
            } else {
              // Otherwise proceed directly to step 3 
              console.log("Standard pattern selected, manually advancing to step 3");
              setCurrentStep(3);
            }
          } else {
            console.log("Cannot proceed - pattern detection is still ongoing");
            toast({
              title: "Pattern Detection In Progress",
              description: "Please wait for pattern detection to complete.",
              variant: "destructive",
            });
          }
          break;
        case 3:
          // If we're already showing the summary, navigate to home
          if (uploadSummary?.showSummary) {
            navigate('/');
            return;
          }
          
          // Perform upload
          setError(null);
          toast({
            title: "Starting upload process",
            description: "Registering log pattern with the server...",
          });
          
          try {

            
            const result = await handleUpload();
            toast({ 
              title: "Upload successful",
              description: "Your log file has been processed successfully.",
              variant: "default",
            });
            
            // Set upload summary data
            setUploadSummary({
              totalLines: approxLines || 0,
              patternName: selectedPattern?.name || 'Custom Pattern',
              redirectCountdown: 3,
              showSummary: true
            });

            searchQueryParamsStore.resetStore();

            //invalidate cache
            const data = await getSystemInfo(true);
            setSystemInfo(data);

            //
            // Start countdown for redirect
            const timer = setInterval(() => {
              setUploadSummary(prev => {
                if (!prev) return null;
                

                const newCountdown = prev.redirectCountdown - 1;
                if (newCountdown <= 0) {
                  clearInterval(timer);
                  navigate('/');
                 
                  return prev;
                }
                
                return {
                  ...prev,
                  redirectCountdown: newCountdown
                };
              });
            }, 1000);
            
            setRedirectTimer(timer);
            
          } catch (uploadErr) {
            // Ensure token patterns are cleared even if there's an error
           
            toast({
              title: "Upload failed",
              description: uploadErr instanceof Error ? uploadErr.message : "Failed to upload file",
              variant: "destructive",
            });
            throw uploadErr;
          }
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    }
  };

  const handleBack = () => {  
    if (uploadSummary?.showSummary) {
      // If showing summary, reset it to show the import form again
      setUploadSummary(null);
      if (redirectTimer) {
        clearInterval(redirectTimer);
        setRedirectTimer(null);
      }
      return;
    }
    
    if (currentStep > 1) {
      if (currentStep === 2 && importSource !== 'file') {
        // For non-file providers, go back to source selection
        setImportSource(null);
        setCurrentStep(1 as UploadStep);
      } else {
        setCurrentStep((currentStep - 1) as UploadStep);
      }
    } else {
      navigate('/');
    }
  };

  const handleDetectionComplete = (result: DetectionResult) => {
    console.log("Detection completed with result:", {
      hasError: !!result.error,
      isOngoing: result.isOngoing,
      hasSuggestedPattern: !!result.suggestedPattern,
      hasSelectedPattern: !!selectedPattern,
      importSource
    });
    
    setDetectionResult(result);
    
    // We're disabling auto-advancing behavior - let user manually navigate with Next button
    if (!result.error && result.isOngoing === false && result.suggestedPattern) {
      console.log("Pattern detection successful, but NOT auto-advancing - user should use Next button");
      
      // Still set the suggested pattern if available
      if (result.suggestedPattern) {
        setSelectedPattern(result.suggestedPattern);
      }
    } else if (result.error) {
      console.log("Detection completed with error:", result.error);
      // Don't auto-advance on error, let user modify pattern
    }
  };

  const renderStep = () => {
    // Debug logging
    console.log("Rendering step", currentStep, "importSource:", importSource);
    
    switch (currentStep) {
      case 1:
        return (
          <LogSourceStep
            providers={logSourceProviders}
            importSource={importSource}
            providerRef={logProviderRef}
            handleSourceSelect={handleSourceSelect}
            handleFileInputSelect={handleFileInputSelect}
            handleCloudWatchLogSelect={handleCloudWatchLogSelect}
            handleBackToSourceSelection={handleBackToSourceSelection}
          />
        );
        
      case 2:
        // All log sources use the same pattern detection workflow
        console.log("Rendering FileAnalyzing, filePreview:", filePreview?.lines?.length);
        return (
          <FileAnalyzing 
           onDetectionComplete={handleDetectionComplete}
           showSaveDialog={showSavePatternDialog}
           onSaveDialogClose={handleSavePatternDialogClose}
          />
        );
      case 3:
        // If we have upload summary, show that instead of the import form
        if (uploadSummary?.showSummary) {
          return <SuccessSummary uploadSummary={uploadSummary} />;
        }
        
        return (
          <ImportConfirm />
        );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="w-full mx-auto px-10 py-10">
        {/* Page Header */}
        <div className="flex justify-between items-center mb-8 px-2">
          <div className="flex items-center">
            <FileUp className="h-8 text-blue-600 mr-3" />
            <h1 className="text-xl font-bold text-gray-800">Import Log Wizard</h1>
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
            
            {renderStep()}

            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
                {error}
              </div>
            )}
            
            {/* Navigation Buttons */}
            <div className="flex justify-between pt-4">
              <Button 
                variant="outline" 
                onClick={handleBack}
                disabled={isUploading}
              >
                {currentStep === 1 ? 'Cancel' : 'Back'}
              </Button>
              
              {/* Next button logic */}
              <Button 
                onClick={handleNext}
                disabled={
                  isUploading || 
                  (currentStep === 1 && (
                    !importSource || 
                    (importSource === 'file' && !selectedFile)
                  ))
                }
                className="bg-blue-600 hover:bg-blue-700"
              >
                {currentStep === 3 ? (
                  uploadSummary?.showSummary ? 'Go to Home' : 'Import'
                ) : (
                  'Next'
                )}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Import; 