import { useCallback, useRef } from 'react';

import { useIngestEnd, useIngestLogs, useIngestStart } from '@/hooks/useApi';
import { IngestSessionOptions } from '@/lib/api-types';
import { useImportStore } from '@/stores/useImportStore';
import type { ImportFile, UploadProgressHookResult } from '../types';
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
    timestampInference,
    timestampOverrides,
    sourceMTime,
    files,
    updateFile,
  } = useImportStore();

  // Effective timestamp config sent to /ingest/start = sniffed
  // resolution overlaid with the user's overrides. Returns undefined
  // when no inference exists yet (e.g. CloudWatch path) so the
  // backend falls through to legacy ForceStart* handling.
  const effectiveTimestampConfig = () => {
    if (!timestampInference) return undefined;
    return { ...timestampInference.resolution, ...timestampOverrides };
  };

  const progressRef = useRef(0);

  const ingestStartApi = useIngestStart();
  const ingestLogsApi = useIngestLogs();
  const ingestEndApi = useIngestEnd();

  // --- Multi-file upload ---
  const handleMultiFileUpload = useCallback(async (
    importFiles: ImportFile[],
    fileService: LogSourceProviderService
  ): Promise<ImportFile[]> => {
    setIsUploading(true);
    const results: ImportFile[] = [];

    for (const importFile of importFiles) {
      // Mark this file as uploading
      updateFile(importFile.id, { uploadStatus: 'uploading', uploadProgress: 0 });

      try {
        // Step 1: Start ingest session for this file
        // Per-file timestamp resolution: this file's own inference
        // overlaid with this file's own overrides. Falls through to
        // undefined when the file has no inference yet, in which case
        // the backend re-derives defaults (legacy behaviour).
        const fileTsConfig = importFile.timestampInference
          ? { ...importFile.timestampInference.resolution, ...importFile.timestampOverrides }
          : undefined;

        const sessionOptions: IngestSessionOptions = {
          pattern: importFile.selectedPattern?.pattern || '%{GREEDYDATA:message}',
          name: importFile.selectedPattern?.name || 'Custom Pattern',
          custom_patterns: importFile.selectedPattern?.custom_patterns || {},
          priority: importFile.selectedPattern?.priority || 0,
          source: importFile.fileName,
          smart_decoder: importFile.sessionOptions.smartDecoder,
          force_timezone: importFile.sessionOptions.timezone || undefined,
          force_start_year: importFile.sessionOptions.year || undefined,
          force_start_month: importFile.sessionOptions.month || undefined,
          force_start_day: importFile.sessionOptions.day || undefined,
          source_mtime: importFile.sourceMTime
            ?? (importFile.file.lastModified ? new Date(importFile.file.lastModified).toISOString() : undefined),
          timestamp_config: fileTsConfig,
          meta: { _src: `file.${importFile.fileName}` },
        };

        const startResponse = await ingestStartApi.execute(sessionOptions);
        if (startResponse.status !== 'success' || !startResponse.session_id) {
          throw new Error('Failed to start ingestion session');
        }

        const currentSessionID = startResponse.session_id;
        let handledLines = 0;

        // Step 2: Stream file chunks
        await fileService.handleFileImport(importFile.file, 10000, async (lines, totalLines, next) => {
          const requestBody = {
            logs: lines,
            session_id: currentSessionID,
          };

          const response = await ingestLogsApi.execute(requestBody);
          if (response.status !== 'success') {
            throw new Error(`Failed to ingest chunk`);
          }

          handledLines += lines.length;
          const progress = Math.ceil((handledLines / totalLines) * 100);
          updateFile(importFile.id, { uploadProgress: progress, totalLinesProcessed: handledLines });
          next();
        });

        // Step 3: End session
        await ingestEndApi.execute(currentSessionID);

        updateFile(importFile.id, {
          uploadStatus: 'success',
          uploadProgress: 100,
          totalLinesProcessed: handledLines,
        });

        results.push({ ...importFile, uploadStatus: 'success', totalLinesProcessed: handledLines });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Upload failed';
        updateFile(importFile.id, {
          uploadStatus: 'failed',
          uploadError: errorMsg,
        });
        results.push({ ...importFile, uploadStatus: 'failed', uploadError: errorMsg });

        // Try to clean up the session
        try {
          if (sessionID) await ingestEndApi.execute(sessionID);
        } catch { /* ignore cleanup error */ }
      }
    }

    setIsUploading(false);
    return results;
  }, [updateFile, setIsUploading, ingestStartApi, ingestLogsApi, ingestEndApi, sessionID]);

  // --- Legacy single-file upload ---
  const handleUpload = useCallback(async (provider: LogSourceProviderService) => {
    try {
      setIsUploading(true);
      progressRef.current = 0;
      setUploadProgress(0);

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
        source_mtime: sourceMTime || undefined,
        timestamp_config: effectiveTimestampConfig(),
        meta: metadata
      };

      const startResponse = await ingestStartApi.execute(ingestSessionOptions);
      if (startResponse.status !== 'success' || !startResponse.session_id) {
        throw new Error('Failed to start ingestion session');
      }

      const currentSessionID = startResponse.session_id;
      setSessionID(currentSessionID);

      progressRef.current = 0;
      setUploadProgress(0);

      let handledLines = 0;
      let i = 0;

      await provider.handleFileImport(selectedFileHandle, 10000, async (lines, totalLines, next) => {
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
        setTotalLines(handledLines);
        next();
      });

      await ingestEndApi.execute(currentSessionID);
      setTotalLines(handledLines);

      progressRef.current = 100;
      setUploadProgress(100);
    } catch (error) {
      console.error('Upload failed:', error);
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
    handleUpload: (provider: LogSourceProviderService) => handleUpload(provider),
    handleMultiFileUpload,
  };
};

export default useUpload;
