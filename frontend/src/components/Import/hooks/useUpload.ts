import { useCallback, useRef, useMemo } from 'react';

import type { 
  UploadProgressHookResult 
} from '../types';
import { useImportStore } from '@/stores/useImportStore';
import { useIngestEnd, useIngestFile, useIngestLogs, useIngestStart, useTokenizerOperations } from '@/hooks/useApi';
import { IngestSessionOptions } from '@/lib/api-types';
import { useCloudWatchStore } from '@/stores/useCloudWatchStore';
import { LogSourceProviderService } from '../types';
export const useUpload = (): UploadProgressHookResult => {
  const {
    selectedFileName,
    selectedFileHandle,
    selectedPattern,
    sessionID,
    metadata,
    setSessionID,
    isUploading,
    uploadProgress,
    approxLines,
    setIsUploading,
    setUploadProgress,
    setApproxLines,
    setTotalLines,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    sessionOptionsFileName

  } = useImportStore();
  


  // Use a ref to track the current progress value
  const progressRef = useRef(0);
  
  // Get the API functions from hooks outside the handleUpload function
  const ingestStartApi = useIngestStart();
  const ingestLogsApi = useIngestLogs();
  const ingestEndApi = useIngestEnd();    
  
  const handleUpload = useCallback(async (provider: LogSourceProviderService) => {

    console.log("Starting upload with provider");

    
    try {
      setIsUploading(true);
      progressRef.current = 0;
      setUploadProgress(0);
      
      // Step 1: Start the ingestion session
      const ingestSessionOptions: IngestSessionOptions = {
        pattern: selectedPattern.pattern,
        name: selectedPattern.name,
        custom_patterns: selectedPattern.custom_patterns,
        priority: selectedPattern.priority,
        source: selectedFileName,
        smart_decoder: sessionOptionsSmartDecoder,
        force_timezone: sessionOptionsTimezone,
        force_start_year: sessionOptionsYear,
        force_start_month: sessionOptionsMonth,
        force_start_day: sessionOptionsDay,
        meta: metadata
      };
      
      const startResponse = await ingestStartApi.execute(ingestSessionOptions);
      if (startResponse.status !== 'success' || !startResponse.session_id) {
        throw new Error('Failed to start ingestion session');
      }
      
      // Store the session ID
      const currentSessionID = startResponse.session_id;
      setSessionID(currentSessionID);
      
      // Update progress to 0%
      progressRef.current = 0;
      setUploadProgress(0);
      
      let handledLines = 0;
      let i = 0;

      // This is where we call the provider's handleFileImport method
      await provider.handleFileImport(selectedFileHandle, 10000, async(lines, totalLines, next) =>{
        
        // Provider will call back with a chunk of lines
        console.log("Ingesting chunk", i + 1, "of", totalLines);
        setApproxLines(totalLines);
        const requestBody = {
          logs: lines,
          session_id: currentSessionID
        };
        i++;
        const response = await ingestLogsApi.execute(requestBody);
       
        if (response.status !== 'success') {
          throw new Error(`Failed to ingest chunk ${i + 1}`);
        }
        handledLines += lines.length;
        setUploadProgress(Math.ceil(handledLines / totalLines * 100));
        next();
      })
   
      // Step 4: End the ingestion session
      await ingestEndApi.execute(currentSessionID);
      setTotalLines(handledLines);
      
      progressRef.current = 100;  
      setUploadProgress(100);
    } catch (error) {
      console.error('Upload failed:', error);
      // Try to end the ingestion session even if there was an error
      try {
        if (sessionID) {
          await ingestEndApi.execute(sessionID);
        }
      } catch (endError) {
        console.error('Failed to end ingestion session:', endError);
      }
      throw error;
    } finally {
      setIsUploading(false);
    }
  }, [isUploading, selectedFileHandle, selectedFileName, selectedPattern, sessionOptionsSmartDecoder, sessionOptionsTimezone, sessionOptionsYear, sessionOptionsMonth, sessionOptionsDay, metadata]);

  return {
    isUploading,
    uploadProgress,
    approxLines,
    handleUpload: (provider: LogSourceProviderService) => handleUpload(provider)
  };
};

export default useUpload; 