import { useCallback, useEffect, useRef } from 'react';

import { useIngestEnd, useIngestLogs, useIngestStart } from '@/hooks/useApi';
import { IngestSessionOptions } from '@/lib/api-types';
import { sessionMultilineOption, useImportStore } from '@/stores/useImportStore';
import type { ImportFile, MultiFileUploadResult, UploadProgressHookResult } from '../types';
import { LogSourceProviderService } from '../types';

export const useUpload = (): UploadProgressHookResult => {
  const {
    isUploading,
    uploadProgress,
    approxLines,
    setIsUploading,
    updateFile,
  } = useImportStore();

  const ingestStartApi = useIngestStart();
  const ingestLogsApi = useIngestLogs();
  const ingestEndApi = useIngestEnd();
  const activeAbortController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeAbortController.current?.abort();
  }, []);

  // --- Multi-file upload ---
  const handleMultiFileUpload = useCallback(async (
    importFiles: ImportFile[],
    fileService: LogSourceProviderService,
  ): Promise<MultiFileUploadResult> => {
    setIsUploading(true);
    const results: ImportFile[] = [];
    const abortController = new AbortController();
    activeAbortController.current = abortController;

    try {
      for (const importFile of importFiles) {
        if (abortController.signal.aborted) {
          updateFile(importFile.id, {
            uploadStatus: 'failed',
            uploadError: 'Import cancelled',
          });
          results.push({ ...importFile, uploadStatus: 'failed', uploadError: 'Import cancelled' });
          continue;
        }

        // Mark this file as uploading
        updateFile(importFile.id, { uploadStatus: 'uploading', uploadProgress: 0 });

        let currentSessionID: string | undefined;
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
            multiline: sessionMultilineOption(useImportStore.getState()),
          };

          const startResponse = await ingestStartApi.execute(sessionOptions, abortController.signal);
          if (startResponse.status !== 'success' || !startResponse.session_id) {
            throw new Error('Failed to start ingestion session');
          }

          currentSessionID = startResponse.session_id;
          let handledLines = 0;

          // Step 2: Stream file chunks. The reader invokes the callback only
          // after the previous request resolves, keeping memory bounded and
          // preserving source order.
          await fileService.handleFileImport(importFile.file, 10000, async ({ lines, bytesRead, totalBytes }) => {
            const requestBody = {
              logs: lines,
              session_id: currentSessionID,
            };

            const response = await ingestLogsApi.execute(requestBody, abortController.signal);
            if (response.status !== 'success') {
              throw new Error('Failed to ingest chunk');
            }

            handledLines += lines.length;
            const progress = totalBytes > 0
              ? Math.min(99, Math.floor((bytesRead / totalBytes) * 100))
              : 0;
            updateFile(importFile.id, { uploadProgress: progress, totalLinesProcessed: handledLines });
          }, abortController.signal);

          // Step 3: End session. Cleanup is repeated in finally only when
          // this call itself fails, because /ingest/end is idempotent.
          await ingestEndApi.execute(currentSessionID);
          currentSessionID = undefined;

          updateFile(importFile.id, {
            uploadStatus: 'success',
            uploadProgress: 100,
            totalLinesProcessed: handledLines,
          });

          results.push({ ...importFile, uploadStatus: 'success', totalLinesProcessed: handledLines });
        } catch (error) {
          const errorMsg = abortController.signal.aborted
            ? 'Import cancelled'
            : error instanceof Error ? error.message : 'Upload failed';
          updateFile(importFile.id, {
            uploadStatus: 'failed',
            uploadError: errorMsg,
          });
          results.push({ ...importFile, uploadStatus: 'failed', uploadError: errorMsg });
        } finally {
          // Always close the session created for this file, including when
          // reading, upload, decoding, or storage fails.
          if (currentSessionID) {
            try {
              await ingestEndApi.execute(currentSessionID);
            } catch {
              // The original failure is more useful to the caller. The
              // backend's cleanup sweeper handles an unavailable end call.
            }
          }
        }
      }
    } finally {
      if (activeAbortController.current === abortController) {
        activeAbortController.current = null;
      }
      setIsUploading(false);
    }

    return { files: results, cancelled: abortController.signal.aborted };
  }, [
    updateFile,
    setIsUploading,
    ingestStartApi,
    ingestLogsApi,
    ingestEndApi,
  ]);

  const cancelUpload = useCallback(() => {
    activeAbortController.current?.abort();
  }, []);

  return {
    isUploading,
    uploadProgress,
    approxLines,
    handleMultiFileUpload,
    cancelUpload,
  };
};

export default useUpload;
