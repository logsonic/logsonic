import { FC, useEffect, useState } from 'react';
import { Loader2, ChevronDown, File, Cloud } from 'lucide-react';
import { suggestPatterns, parseLogs, getGrokPatterns } from '../../../lib/api-client';
import type { DetectionResult, Pattern } from '../types';
import { LogPatternSelection } from './LogPatternSelection';
import { PatternTestResults } from './PatternTestResults';
import { extractFields } from '../utils/patternUtils';
import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';
import { CustomPatternSelector } from './CustomPatternSelector';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface FileAnalyzingProps {
  onDetectionComplete: (result: DetectionResult) => void;
  showSaveDialog?: boolean;
  onSaveDialogClose?: () => void;
}

export const FileAnalyzing: FC<FileAnalyzingProps> = ({
  onDetectionComplete,
  showSaveDialog = false,
  onSaveDialogClose
}) => {
  const [isAnalyzing, setIsAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);

   
  const {
    setSelectedPattern, 
    selectedPattern, 
    setSelectedFile, 
    selectedFile, 
    setFilePreview, 
    filePreview, 
    setCurrentStep, 
    currentStep, 
    isCreateNewPatternSelected,
    availablePatterns,
    createNewPattern,
    setCreateNewPattern,
    handlePatternOperation,
    setParsedLogs,
    setError: setStoreError,
    importSource,
    sessionOptionsFileName
  } = useImportStore();

  useEffect(() => {
    const analyzeFile = async () => {
      // Enhanced debugging info
      console.log("FileAnalyzing useEffect triggered", { 
        hasFilePreview: !!filePreview, 
        previewLines: filePreview?.lines?.length,
        hasSelectedFile: !!selectedFile,
        importSource,
        currentStep
      });
      
      if (!filePreview?.lines?.length || !selectedFile) {
        console.error("Missing file preview or selected file, aborting analysis");
        return;
      }

      console.log("Analyzing file in FileAnalyzing component", importSource, filePreview.lines.length, "lines");
      
      try {
        setIsAnalyzing(true);
        setError(null);
        setStoreError(null);

        // Try to auto-detect the pattern
        console.log("Starting pattern suggestion...");
        const suggestResponse = await suggestPatterns({
          logs: filePreview.lines
        });
        console.log("Pattern suggestion complete", suggestResponse.results?.length || 0, "patterns found");

      
        if (suggestResponse.results && suggestResponse.results.length > 0) {
          const bestMatch = suggestResponse.results[0];
          console.log("Testing best match pattern:", bestMatch.pattern);
          
          // Test the suggested pattern
          const parseResponse = await parseLogs({
            logs: filePreview.lines,
            grok_pattern: bestMatch.pattern,
            custom_patterns: bestMatch.custom_patterns || {}
          });

          if (parseResponse.logs && parseResponse.logs.length > 0) {
            console.log("Pattern successfully parsed logs");
            // Check if the suggested pattern matches any server pattern
            let suggestedPattern: Pattern;
            const matchingServerPattern = availablePatterns.find(p => 
              p.pattern === bestMatch.pattern
            );
            
            if (matchingServerPattern) {
              // Use the server pattern if it matches
              suggestedPattern = matchingServerPattern;
            } else {
              // Otherwise use the auto-detected pattern
              suggestedPattern = {
                name: bestMatch.pattern_name || 'Auto-detected',
                pattern: bestMatch.pattern,
                description: bestMatch.pattern_description || 'Automatically detected pattern',
                custom_patterns: bestMatch.custom_patterns,
                fields: extractFields(bestMatch.pattern)
              };
            }
            
            setSelectedPattern(suggestedPattern);
            setParsedLogs(parseResponse.logs);
            
            console.log("Calling onDetectionComplete with successful match", suggestedPattern.name, "- will NOT auto-advance");
            onDetectionComplete({
              isOngoing: false,
              suggestedPattern,
              parsedLogs: parseResponse.logs
            });
          } else {
            // Pattern detection failed to parse logs, switch to custom pattern
            console.log("Pattern detected but failed to parse logs, switching to custom pattern");
            setCreateNewPattern(createNewPattern);
            handlePatternChange(selectedPattern);
            onDetectionComplete({
              isOngoing: false,
              error: 'Auto-detected pattern failed to parse logs'
            });
          }
        } else {
          // No pattern detected, show custom pattern selector
          console.log("No patterns could be detected, switching to default pattern");
          setCreateNewPattern(DEFAULT_PATTERN);
          handlePatternChange(DEFAULT_PATTERN);
          onDetectionComplete({
            isOngoing: false,
            error: 'No patterns could be automatically detected'
          });
        }
      } catch (err) {
        // Any error in the process, switch to custom pattern
        const errorMessage = err instanceof Error ? err.message : 'Failed to analyze log file';
        console.error("Error during pattern detection:", errorMessage);
        setError(errorMessage);
        setStoreError(errorMessage);

        setCreateNewPattern(DEFAULT_PATTERN);
        handlePatternChange(DEFAULT_PATTERN);
        onDetectionComplete({
          isOngoing: false,
          error: errorMessage
        });
      } finally {
        console.log("Analysis completed, isAnalyzing set to false");
        setIsAnalyzing(false);
      }
    };

    analyzeFile();
  }, []);

  // Used to trigger custom pattern testing but now moved to the store
  // Only define wrapper functions that call the store function

  const handlePatternChange = (pattern: Pattern) => {
    setIsAnalyzing(true);
    handlePatternOperation(
      pattern, 
      true,
      (logs) => {
        setParsedLogs(logs);
        onDetectionComplete({
          isOngoing: false,
          suggestedPattern: pattern,
          parsedLogs: logs
        });
        setIsAnalyzing(false);
      },
      (errorMsg) => {
        setError(errorMsg);
        setStoreError(errorMsg);
        setIsAnalyzing(false);
      }
    );
  };

  const handlePatternTest = (pattern: Pattern) => {
    setIsAnalyzing(true);
    handlePatternOperation(
      pattern, 
      false,
      (logs) => {
        setParsedLogs(logs);
        setIsAnalyzing(false);
      },
      (errorMsg) => {
        setError(errorMsg);
        setStoreError(errorMsg);
        setIsAnalyzing(false);
      }
    );
  };

  // Determine what type of logs we're analyzing
  const getLogSourceInfo = () => {
    if (importSource === 'cloudwatch') {
      return {
        icon: <Cloud className="h-5 w-5 text-blue-500 mr-2" />,
        text: `Analyzing CloudWatch logs: ${sessionOptionsFileName || 'Unknown'}`
      };
    } else {
      return {
        icon: <File className="h-5 w-5 text-blue-500 mr-2" />,
        text: `Analyzing file: ${selectedFile?.name || 'Unknown'}`
      };
    }
  };

  const logSourceInfo = getLogSourceInfo();

  return (
    <div className="space-y-6">
      {/* Log Source Information */}
      <div className="flex items-center p-3 bg-blue-50 text-blue-700 rounded-md">
        {logSourceInfo.icon}
        <span className="text-sm font-medium">{logSourceInfo.text}</span>
      </div>
      
      {isAnalyzing ? (
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-gray-600">Analyzing log format...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {isCreateNewPatternSelected && (
            <div className="flex items-center gap-2 p-3 bg-yellow-50 text-yellow-700 rounded-md border border-yellow-200">
              <svg className="h-5 w-5 text-yellow-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="font-medium">Detected: Custom Pattern</p>
                <p className="text-sm">No standard pattern matched your logs. Please define a custom pattern below.</p>
              </div>
            </div>
          )}
          
          <div>

            <LogPatternSelection
              initialPattern={selectedPattern}
              onPatternChange={handlePatternChange}
              previewLines={filePreview?.lines || []}
            />
          </div>
          

          
          {isCreateNewPatternSelected && (
            <div>
              <CustomPatternSelector 
                previewLines={filePreview?.lines || []}
                onPatternTest={handlePatternTest}
                showSaveDialog={showSaveDialog}
                onSaveDialogClose={onSaveDialogClose}
              />
            </div>
          )}
          
          <div className="mt-6">
            <PatternTestResults
              pattern={selectedPattern?.pattern || ''}
              customPatterns={selectedPattern?.custom_patterns || {}}
              logs={filePreview?.lines || []}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default FileAnalyzing; 