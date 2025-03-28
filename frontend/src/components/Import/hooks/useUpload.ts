import { useCallback, useRef, useMemo } from 'react';

import type { 
  UploadProgressHookResult 
} from '../types';
import { useImportStore } from '@/stores/useImportStore';
import { useIngestEnd, useIngestFile, useIngestLogs, useIngestStart, useTokenizerOperations } from '@/hooks/useApi';
import { IngestSessionOptions } from '@/lib/api-types';
import { useCloudWatchStore } from '@/stores/useCloudWatchStore';

export const useUpload = (): UploadProgressHookResult => {
  const {
    selectedFile,
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
  
  const handleUpload = useCallback(async () => {
    if (!selectedFile || !selectedPattern) {
      throw new Error('No file or pattern selected');
    }


    console.log("Starting upload");


    
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
        source: selectedFile.name,
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
      
      // Update progress to 10%
      progressRef.current = 10;
      setUploadProgress(10);
      
      // Step 2: Read the file and prepare for ingestion
      const fileContent = await selectedFile.text();
      const lines = fileContent.split('\n').filter(line => line.trim() !== '');
      
      // Update approxLines if we now have a more accurate count
      setApproxLines(lines.length);
      
      // Update progress to 20%
      progressRef.current = 20;
      setUploadProgress(20);
      
      // Step 3: Ingest the logs in chunks
      const chunkSize = 1000; // Send 1000 lines at a time
      const chunks = [];
      for (let i = 0; i < lines.length; i += chunkSize) {
        chunks.push(lines.slice(i, i + chunkSize));
      }
  
      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const requestBody = {
          logs: chunk,
          session_id: currentSessionID
        };
    
        const response = await ingestLogsApi.execute(requestBody);
    
        if (response.status !== 'success') {
          throw new Error(`Failed to ingest chunk ${i + 1}`);
        }
    
        // Calculate progress between 20% and 90%
        const chunkProgress = 20 + ((i + 1) / chunks.length) * 70;
        progressRef.current = chunkProgress;
        setUploadProgress(chunkProgress);
      }

      // Step 4: End the ingestion session
      await ingestEndApi.execute(currentSessionID);

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
  }, [
    selectedFile, 
    selectedPattern, 
    sessionID,
    setSessionID,
    setIsUploading, 
    setUploadProgress, 
    setApproxLines, 
    ingestStartApi, 
    ingestLogsApi, 
    ingestEndApi,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay
  ]);

  return {
    isUploading,
    uploadProgress,
    approxLines,
    handleUpload
  };
};

export default useUpload; 