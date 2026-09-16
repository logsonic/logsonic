import { useCallback, useEffect, useRef } from 'react';

import { LogSourceProviderService } from '../types';

import { waitForIngestJob } from './ingestJobEvents';

import type { ImportFile, MultiFileUploadResult, UploadProgressHookResult } from '../types';

import {
  useCancelIngestJob,
  useIngestEnd,
  useIngestFile,
  useIngestLogs,
  useIngestStart,
} from '@/hooks/useApi';
import { IngestSessionOptions } from '@/lib/api-types';
import { sessionMultilineOption, useImportStore } from '@/stores/useImportStore';

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
  const ingestFileApi = useIngestFile();
  const cancelIngestJobApi = useCancelIngestJob();
  const activeAbortController = useRef<AbortController | null>(null);
  // The in-flight path-ingest job, if any -- cancelUpload needs this to
  // tell the backend to actually stop reading, not just abandon the
  // browser-side poll (aborting the fetch here does not cancel the
  // server-side goroutine that is still reading the file).
  const activeJobIdRef = useRef<string | null>(null);

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
              ?? (importFile.file?.lastModified ? new Date(importFile.file.lastModified).toISOString() : undefined),
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

          if (importFile.nativePath) {
            // Step 2 (native path, spec now-08): hand the path to the
            // server and follow progress over the live SSE stream instead
            // of streaming chunks -- no file bytes ever cross into the
            // browser.
            const fileResponse = await ingestFileApi.execute({
              session_id: currentSessionID,
              path: importFile.nativePath,
            });
            if (fileResponse.status !== 'accepted' || !fileResponse.job_id) {
              throw new Error('Failed to start path-based ingest job');
            }
            activeJobIdRef.current = fileResponse.job_id;

            const job = await waitForIngestJob(fileResponse.job_id, (progressJob) => {
              const progress = progressJob.bytes_total
                ? Math.min(99, Math.floor((progressJob.bytes_read / progressJob.bytes_total) * 100))
                : 0;
              updateFile(importFile.id, {
                uploadProgress: progress,
                totalLinesProcessed: progressJob.lines,
                ingestRateLinesPerS: progressJob.rate_lines_per_s,
                rowsFailed: progressJob.rows_failed,
              });
            }, abortController.signal);

            if (job.state === 'cancelled') {
              throw new Error('Import cancelled');
            }
            if (job.state === 'error') {
              throw new Error(job.error || 'Path-based ingest job failed');
            }
            // job.lines (physical lines read), not rows_stored, for parity
            // with the chunk path's handledLines below -- both count lines
            // read/sent, not lines that successfully parsed. Parity is
            // modulo blank lines: ingestfile.Reader.Lines() counts every
            // physical line including empty ones, while the chunk path's
            // splitCompleteLines() drops empty lines before they're ever
            // sent. rowsFailed is carried separately so the UI can flag a
            // partial-failure job that still finished as "done".
            handledLines = job.lines;
            updateFile(importFile.id, { rowsFailed: job.rows_failed });
          } else {
            if (!importFile.file) {
              // Every ImportFile has exactly one of file / nativePath set
              // (see the type's own doc comment); this is defense against
              // that invariant breaking, not an expected runtime path.
              throw new Error('This file has neither browser content nor a native path to import');
            }
            // Step 2 (browser File, unchanged): stream chunks. The reader
            // invokes the callback only after the previous request
            // resolves, keeping memory bounded and preserving source order.
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
          }

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
          // A cancelled browser-file fetch throws the browser's own AbortError
          // (an unhelpful, inconsistently-worded native message), so an abort
          // normally gets the friendly override below. A message starting
          // with "Import cancel" is already ours -- the normal cancel thrown
          // either here or by waitForIngestJob ("Import cancelled"), or that
          // wait's own fallback-timeout rejection -- so it's kept as-is
          // instead of being flattened to the generic text (now-08 phase 9).
          // This depends on that literal prefix: changing the wording in
          // either place without updating the other silently reverts this.
          // waitForIngestJob's "Ingest job disappeared from the registry"
          // rejection doesn't match the prefix and still gets the generic
          // override post-abort -- fine, since a gone job is definitely
          // stopped either way.
          const hasOwnCancelMessage = error instanceof Error && error.message.startsWith('Import cancel');
          const errorMsg = hasOwnCancelMessage
            ? (error as Error).message
            : abortController.signal.aborted
              ? 'Import cancelled'
              : error instanceof Error ? error.message : 'Upload failed';
          updateFile(importFile.id, {
            uploadStatus: 'failed',
            uploadError: errorMsg,
          });
          results.push({ ...importFile, uploadStatus: 'failed', uploadError: errorMsg });
        } finally {
          activeJobIdRef.current = null;
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
    ingestFileApi,
  ]);

  const cancelUpload = useCallback(() => {
    activeAbortController.current?.abort();
    // Aborting the fetch above only stops the browser from waiting on it;
    // a running path-ingest job keeps reading on the server until told to
    // stop. Fire-and-forget: waitForIngestJob's own abort listener is what
    // actually unblocks the wait (it rejects immediately on the signal),
    // so this call doesn't need to be awaited before that happens.
    const jobId = activeJobIdRef.current;
    if (jobId) {
      cancelIngestJobApi.execute(jobId).catch(() => {
        // Best-effort; the job will still time out on its own 6h ceiling
        // if this request is lost, and the wizard has already moved on.
      });
    }
  }, [cancelIngestJobApi]);

  return {
    isUploading,
    uploadProgress,
    approxLines,
    handleMultiFileUpload,
    cancelUpload,
  };
};

export default useUpload;
