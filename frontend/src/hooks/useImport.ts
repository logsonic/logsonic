import { useState, useCallback, useEffect } from 'react';
import { 
  suggestPatterns,
  parseLogs
} from '@/lib/api-client';
import { useImportStore, UploadStep } from '@/stores/useImportStore';
import { Pattern } from '@/components/Import/types';
import { SuggestResponse, IngestResponse } from '@/lib/api-types';

/**
 * Hook for managing the import process using the ImportStore
 */
export const useImport = () => {
  const store = useImportStore();
  
  /**
   * Handle file selection
   */
  const handleFileSelect = useCallback(async (file: File) => {
    store.setSelectedFile(file);
    store.setError(null);
    
    // Reset related state when a new file is selected
    store.setFilePreview(null);
    store.setDetectionResult(null);
    store.setSuggestResponse(null);
    
    return file;
  }, []);
  
  /**
   * Generate file preview
   */
  const generateFilePreview = useCallback(async (file: File, maxLines = 100) => {
    if (!file) {
      store.setError('No file selected');
      return null;
    }
    
    try {
      // Read a portion of the file to generate preview
      const fileSize = file.size;
      const sampleSize = Math.min(fileSize, 100 * 1024); // 100KB sample
      const sample = await file.slice(0, sampleSize).text();
      const allLines = sample.split('\n');
      const previewLines = allLines.slice(0, maxLines);
      
      // Calculate approximate total lines
      const bytesPerLine = sampleSize / (allLines.length || 1);
      const estimatedTotalLines = Math.ceil(fileSize / bytesPerLine);
      
      const filePreview = {
        lines: previewLines,
        totalLines: estimatedTotalLines,
        fileSize
      };
      
      store.setFilePreview(filePreview);
      store.setApproxLines(estimatedTotalLines);
      
      return filePreview;
    } catch (error) {
      store.setError(`Failed to generate file preview: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, []);
  
  /**
   * Detect pattern from log lines
   */
  const detectPattern = useCallback(async (logLines: string[]) => {
    if (!logLines || logLines.length === 0) {
      store.setError('No log lines provided for pattern detection');
      return null;
    }
    
    try {
      store.setError(null);
      
      // Call the suggest API
      const response = await suggestPatterns({ logs: logLines });
      store.setSuggestResponse(response);
      
      if (response.results && response.results.length > 0) {
        // Get the best match
        const bestMatch = response.results[0];
        
        // Extract fields from the pattern
        const fieldRegex = /%\{[^:}]+:([^}]+)\}/g;
        const fields: string[] = [];
        let match;
        
        while ((match = fieldRegex.exec(bestMatch.pattern || '')) !== null) {
          fields.push(match[1]);
        }
        
        // Create a Pattern object from the best match
        const pattern: Pattern = {
          name: bestMatch.pattern_name || 'Auto-detected',
          pattern: bestMatch.pattern || '',
          description: bestMatch.pattern_description || 'Automatically detected pattern',
          custom_patterns: bestMatch.custom_patterns || {},
          fields
        };
        
        store.setSelectedPattern(pattern);
        
        // Create detection result
        const detectionResult = {
          isOngoing: false,
          suggestedPattern: pattern,
          parsedLogs: bestMatch.parsed_logs || [],
          score: bestMatch.score || 0
        };
        
        store.setDetectionResult(detectionResult);
        return detectionResult;
      } else {
        store.setError('No pattern could be detected from the provided logs');
        return null;
      }
    } catch (error) {
      store.setError(`Pattern detection failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, []);
  
  /**
   * Move to the next step in the import process
   */
  const nextStep = useCallback(() => {
    const currentStep = store.currentStep;
    if (currentStep < 4) {
      store.setCurrentStep((currentStep + 1) as UploadStep);
    }
  }, []);
  
  /**
   * Move to the previous step in the import process
   */
  const prevStep = useCallback(() => {
    const currentStep = store.currentStep;
    if (currentStep > 1) {
      store.setCurrentStep((currentStep - 1) as UploadStep);
    }
  }, []);
  
  return {
    // State from store
    currentStep: store.currentStep,
    selectedFile: store.selectedFile,
    filePreview: store.filePreview,
    availablePatterns: store.availablePatterns,
    selectedPattern: store.selectedPattern,
    customPattern: store.customPattern,
    detectionResult: store.detectionResult,
    suggestResponse: store.suggestResponse,
    isUploading: store.isUploading,
    uploadProgress: store.uploadProgress,
    approxLines: store.approxLines,
    sessionOptions: store.sessionOptions,
    error: store.error,
    
    // Actions from store
    setSelectedPattern: store.setSelectedPattern,
    setCustomPattern: store.setCustomPattern,
    setSessionOptions: store.setSessionOptions,
    setAvailablePatterns: store.setAvailablePatterns,
    reset: store.reset,
    
    // Custom actions
    handleFileSelect,
    generateFilePreview,
    detectPattern,
    nextStep,
    prevStep
  };
}; 