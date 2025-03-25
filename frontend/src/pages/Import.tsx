import { FC, useEffect, useState } from 'react';  
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ArrowLeft, ArrowRight, CheckCircle, Store, FileUp } from "lucide-react";
import { 
  FileSelection, 
  FileAnalyzing, 
  ImportConfirm,
  SuccessSummary
} from '../components/Import/UploadSteps';
import { useUpload } from '../components/Import/hooks';
import type { Pattern, DetectionResult } from '../components/Import/types';
import { useToast } from "../components/ui/use-toast";
import { clearTokenizer, getGrokPatterns, getSystemInfo } from '../lib/api-client';
import { extractFields } from '../components/Import/utils/patternUtils';
import { useImportStore, UploadStep, DEFAULT_PATTERN } from '../stores/useImportStore';
import { useNavigate } from 'react-router-dom';
import { useSearchQueryParamsStore } from '../stores/useSearchParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import React from 'react';

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
    { number: 1, label: "Choose Log File" },
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
    selectedPattern,
    handleFileSelect,
    setSelectedPattern,
    setFilePreview,
    currentStep,
    setCurrentStep,
    detectionResult,
    setDetectionResult,
    createNewPattern
  } = importStore;

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

  // Function to handle pattern save dialog close
  const handleSavePatternDialogClose = () => {
    setShowSavePatternDialog(false);
    // Now proceed to step 3
    setCurrentStep(3);
  };

  //Invoked when user clicks next button
  const handleNext = async () => {
    try {
      switch (currentStep) {
        case 1:
          // Trigger file selection and move to analyzing step
          if (!selectedFile) {
            // Don't proceed if no file is selected
            toast({
              title: "File Required",
              description: "Please select a file to import before proceeding.",
              variant: "destructive",
            });
            return;
          }
          
          if (selectedFile) {
            setCurrentStep(2);
          }
          break;
        case 2:
          // Check if there's a custom pattern that needs to be saved
          if (detectionResult?.isOngoing === false) {
            // If user created a custom pattern, show save dialog first
            if (importStore.isCreateNewPatternSelected) {
              setShowSavePatternDialog(true);
            } else {
              // Otherwise proceed directly to step 3
              setCurrentStep(3);
            }
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
    
    setCurrentStep((currentStep - 1) as UploadStep);
  };


  // Invoked when auto-detection is complete
  const handleDetectionComplete = (result: DetectionResult) => {
    if (result.suggestedPattern) {
      // Check if the suggested pattern matches any server pattern
      const matchingServerPattern = importStore.availablePatterns.find(p => 
        p.pattern === result.suggestedPattern?.pattern
      );
      
      if (matchingServerPattern) {
        // Use the server pattern if it matches
        setSelectedPattern(matchingServerPattern);
      } else {
        // Use the default pattern if no server pattern matches
        importStore.setCreateNewPattern(DEFAULT_PATTERN);
      }
    } else {
      // Use the default pattern if no server pattern matches
      importStore.setCreateNewPattern(DEFAULT_PATTERN);
    }
    
    // Store the detection result in the import store
    setDetectionResult(result);
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <FileSelection
            onFileSelect={handleFileSelect}
          />
        );
      case 2:
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
                <React.Fragment key={step.number}>
                  <StepIndicator 
                    number={step.number} 
                    label={step.label} 
                    isActive={currentStep >= step.number} 
                  />
                  {index < steps.length - 1 && (
                    <div className="h-px bg-gray-300 flex-grow mx-2"></div>
                  )}
                </React.Fragment>
              ))}
            </div>
            
            {renderStep()}

            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
                {error}
              </div>
            )}

            <div className="flex justify-between pt-4">
              <Button
                variant="outline"
                onClick={handleBack}
                className="h-12 w-32"
                disabled={currentStep === 1}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              
              <Button
                onClick={handleNext}
                className="bg-blue-600 text-white h-12 w-32"
                disabled={
                  (currentStep === 1 && !selectedFile) ||
                  (currentStep === 3 && isUploading && !uploadSummary?.showSummary)
                }
              >
                {currentStep === 3 ? (
                  uploadSummary?.showSummary ? 
                    "Go to Home" : 
                    (isUploading ? "Uploading..." : "Import")
                ) : (
                  <>
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
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