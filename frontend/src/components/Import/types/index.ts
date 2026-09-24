// Types for the Import functionality

import type { TimestampInference, TimestampResolution } from '@/lib/api-types';

export interface Pattern {
  name: string;
  pattern: string;
  description: string;
  custom_patterns?: Record<string, string>;
  fields?: string[];
  priority?: number;
}

export interface FilePreview {
  lines: string[];
  filename: string;
}

export interface DetectionResult {
  isOngoing: boolean;
  suggestedPattern?: Pattern;
  parsedLogs?: Record<string, any>[];
  error?: string;
}

// --- Multi-file import types ---

export type FileDetectionStatus = 'pending' | 'detecting' | 'detected' | 'failed';
export type FileUploadStatus = 'pending' | 'uploading' | 'success' | 'failed';

export interface ImportFile {
  id: string;
  // Exactly one of file / nativePath is set. file: a browser-selected or
  // dropped File, read and chunk-uploaded as today. nativePath: an
  // absolute server-readable path (spec now-08), ingested via
  // POST /ingest/file + job polling instead -- no bytes ever cross into
  // the browser. Phase 4 wires the nativePath upload branch only; nothing
  // constructs a nativePath-backed ImportFile yet (that's phase 5's
  // FileSelection.tsx wiring), so this is additive and doesn't change
  // behavior for any file selected today.
  file?: File;
  nativePath?: string;
  fileName: string;
  fileSize: number;
  previewLines: string[];
  approxLines: number;

  // Pattern detection
  detectedPattern: Pattern | null;
  selectedPattern: Pattern | null;
  isCustomPattern: boolean;
  customPattern: Pattern | null;
  customPatternTokens: Record<string, string>;

  // Detection state
  detectionStatus: FileDetectionStatus;
  detectionError: string | null;

  // Parsed logs preview
  parsedLogs: Record<string, string>[];

  // Upload state
  uploadStatus: FileUploadStatus;
  uploadProgress: number;
  uploadError: string | null;
  totalLinesProcessed: number;
  // Native-path uploads only (spec now-08 phase 6): populated from the
  // "ingest_progress" SSE event's IngestJob snapshot, which the chunk
  // upload path has no equivalent of. undefined for a browser File
  // upload -- UploadingStep only renders these when nativePath is set.
  ingestRateLinesPerS?: number;
  rowsFailed?: number;

  // Per-file session options
  sessionOptions: FileSessionOptions;

  // Match rate (0-100) of each saved pattern against this file's preview,
  // computed lazily when the detail panel's Pattern tab opens. Keyed by
  // pattern name; absent until the alternatives have been tested.
  patternMatches?: Record<string, number>;

  // Timestamp resolution per file. Each file in a batch can have its
  // own anchor (mtime), inferred layout, and user overrides. The
  // upload path reads these instead of the global timestamp* state.
  timestampInference: TimestampInference | null;
  timestampOverrides: Partial<TimestampResolution>;
  timestampConfirmed: boolean;
  sourceMTime: string | null;
}

// Multiline folding for one file. The ingest session is per file, so the
// folding is too: a stack-trace file's ISO8601 header must never fold a
// syslog file in the same batch into one record.
export interface FileMultiline {
  enabled: boolean;
  mode: 'header' | 'indent';
  headerPattern: string;
}

export const DEFAULT_MULTILINE: FileMultiline = {
  enabled: false,
  mode: 'header',
  headerPattern: '',
};

export interface FileSessionOptions {
  smartDecoder: boolean;
  timezone: string;
  year: string;
  month: string;
  day: string;
  // Auto-filled by detection when the suggester finds a multiline layout
  // in this file; editable in the Options tab.
  multiline: FileMultiline;
}

// --- Upload hook types ---

export interface MultiFileUploadResult {
  files: ImportFile[];
  cancelled: boolean;
}

export interface UploadProgressHookResult {
  isUploading: boolean;
  uploadProgress: number;
  approxLines: number;
  handleMultiFileUpload: (
    files: ImportFile[],
    fileService: LogSourceProviderService
  ) => Promise<MultiFileUploadResult>;
  cancelUpload: () => void;
}

// Interface for log provider components that implement ref functionality
export interface LogSourceProviderService {
  name: string;
  // Start the actual import process
  handleFileImport: (
    filehandle: object,
    chunkSize: number,
    callback: (chunk: FileImportChunk) => Promise<void>,
    signal?: AbortSignal
  ) => Promise<void>;
  handleFilePreview: (
    filehandle: object,
    onPreviewReadyCallback: (lines: string[]) => void
  ) => Promise<void>;
}

export interface FileImportChunk {
  lines: string[];
  bytesRead: number;
  totalBytes: number;
}
