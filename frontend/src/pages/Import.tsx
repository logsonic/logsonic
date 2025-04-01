import { FC, Fragment, useEffect, useRef, useState } from 'react';  
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ArrowLeft,FileUp, Cloud } from "lucide-react";
import { ImportConfirmStep } from '../components/Import/UploadSteps/ImportConfirmStep';
import { LogSourceSelectionStep } from '../components/Import/UploadSteps/LogSourceSelectionStep';
import { SuccessSummary } from '../components/Import/UploadSteps/SuccessSummaryStep';
import { FileAnalyzingStep } from '../components/Import/UploadSteps/FileAnalyzingStep';
import type { DetectionResult } from '../components/Import/types';
import { useToast } from "../components/ui/use-toast";
import { getGrokPatterns, getSystemInfo } from '../lib/api-client';
import { extractFields } from '../components/Import/utils/patternUtils';
import { UploadStep, useImportStore } from '../stores/useImportStore';
import { useNavigate } from 'react-router-dom';
import HandleNavigation from '@/components/Import/UploadSteps/HandleNavigation';
import { useFileSelectionService } from '@/components/Import/LocalFileImport/FileSelectionService';
import useUpload from '@/components/Import/hooks/useUpload';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { ErrorBoundary } from '@/lib/error-boundary';
import { useCloudWatchLogProviderService } from '@/components/Import/CloudWatchImport/CloudWatchLogProviderService';


const Import: FC  = () => {
  const { toast } = useToast(); 
  const navigate = useNavigate();
  type UploadSummary = {
    totalLines: number;
    patternName: string;
    redirectCountdown: number;
    showSummary: boolean;
  };
  const [error, setError] = useState<string | null>(null);

  const [redirectTimer, setRedirectTimer] = useState<NodeJS.Timeout | null>(null);
  const {
    selectedPattern,
    importSource,
    reset,
    currentStep,
    readyToImportLogs,
    readyToSelectPattern,
    setReadyToSelectPattern,
    setFileFromBlob,
    setImportSource,
    setSelectedPattern,
    isCreateNewPatternSelected,
    setCurrentStep,
    detectionResult,
    setDetectionResult,
    setAvailablePatterns,
  } = useImportStore();

  const searchQueryParamsStore = useSearchQueryParamsStore();
  const { setSystemInfo } = useSystemInfoStore();
  const {
    isUploading,
    uploadProgress,
    approxLines,
    handleUpload,
  } = useUpload();

  const fileService = useFileSelectionService();
  const cloudWatchService = useCloudWatchLogProviderService();


  // Define steps data
  const steps = [
    { number: 1, label: "Choose Log Source" },
    { number: 2, label: "Define Log Pattern" },
    { number: 3, label: "Confirm Import" },
    { number: 4, label: "Summary" }
  ];

  // Step indicator component
  const StepIndicator = ({ number, label, isActive }: { number: number, label: string, isActive: boolean }) => {
    const isCurrentStep = number === currentStep;
    
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




  // Handle source selection
  const handleSourceSelect = (source: string) => {
    console.log(`Source selected: ${source}`);
  };

  const handleFileSelect = (filename: string) => {
   console.log(`File selected: ${filename}`);
  };

  const handleFilePreview = (lines: string[], filename: string) => {
    console.log("File ready for preview");
    setReadyToSelectPattern(true);
    setCurrentStep(2);
  };
  // Handle back button for any provider
  const handleBackToSourceSelection = () => {
    setImportSource(null);
    console.log(`Back to source selection`);
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
      
      // Still set the suggested pattern if available
      if (result.suggestedPattern) {
        setSelectedPattern(result.suggestedPattern);
      }
    } else if (result.error) {
      console.log("Detection completed with error:", result.error);
      // Don't auto-advance on error, let user modify pattern
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
        return (
          <ImportConfirmStep />
        );
      case 4:

        return (
          <SuccessSummary />
        );
  
      default:
        return null;
    }
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
          if (readyToSelectPattern) {
            // Else simply move to the next step
            // Set current step to 2 (pattern detection)
            console.log(`Advancing to step 2 with import source: ${importSource}`);
            setCurrentStep(2);            
          }


          break;
        case 2:
          // Check if there is a pattern ready to move to import
          if (readyToImportLogs) {
              setCurrentStep(3);
          }
          break;

        case 3:

          // Perform upload
          setError(null);
          toast({
            title: "Starting upload process",
            description: "Registering log pattern with the server...",
          });
          
          try {
            console.log("Uploading logs using provider handler", importSource);

            const provider = importSource === 'cloudwatch' ? cloudWatchService : fileService;
            console.log("Importing with Log Source provider service:", provider);


            await handleUpload(provider);
            toast({ 
              title: "Upload successful",
              description: "Your log file has been processed successfully.",
              variant: "default",
            });
            
            setCurrentStep(4);
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
          
        case 4:
            //invalidate cache
            navigate('/');
          
            // If we're already showing the summary, navigate to home

      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    }
  };

  // When user clicks the back button 

  const handleBack = () => {  
   
    switch (currentStep) {
      case 1:
        // We are already on the source selection step, so we can just navigate to the home page
        navigate('/');
        break;
      case 2:
        // We are in the log pattern detection step, so we need to go back to the source selection step
        // Reset the store to default values
        reset();
        setCurrentStep(1 as UploadStep);
        break;
      case 3:
        // We are in the Import Confirm step, so we need to go back to the log pattern detection step
        setCurrentStep(2 as UploadStep);
        break;
      case 4:
        // We are in the summary step, 
        // Reset the store to default values
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
            {/* Import Log Wizard Icon */}
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
            {/* Step Indicator bar on top of the card*/}
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
            
            {/* Render the current step */}

              {renderCurrentStep()}

            {/* Error message */}
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
                {error}
              </div>
            )}
            
            {/* Navigation Buttons at the bottom of the card*/}
            <HandleNavigation onNext={handleNext} onBack={handleBack} />
          </div>
        </Card>
      </div>
    </div>
    </ErrorBoundary>
  );
};  

export default Import;



