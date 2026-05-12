// Types for the Import functionality

import type { TimestampInference, TimestampResolution } from '@/lib/api-types';

export type UploadStep = 1 | 2 | 3;

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
  file: File;
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

  // Per-file session options
  sessionOptions: FileSessionOptions;

  // Timestamp resolution per file. Each file in a batch can have its
  // own anchor (mtime), inferred layout, and user overrides. The
  // upload path reads these instead of the global timestamp* state.
  timestampInference: TimestampInference | null;
  timestampOverrides: Partial<TimestampResolution>;
  timestampConfirmed: boolean;
  sourceMTime: string | null;
}

export interface FileSessionOptions {
  smartDecoder: boolean;
  timezone: string;
  year: string;
  month: string;
  day: string;
}

// --- Existing types (kept for backward compatibility) ---

export interface UploadProgressHookProps {
  selectedFile: File | null;
  selectedPattern: Pattern | null;
  customPattern: string;
  customPatterns: Record<string, string>;
  detectionResult?: DetectionResult;
}

export interface UploadProgressHookResult {
  isUploading: boolean;
  uploadProgress: number;
  approxLines: number;
  handleMultiFileUpload: (files: ImportFile[], fileService: LogSourceProviderService) => Promise<ImportFile[]>;
}

export interface FileParserHookResult {
  selectedFile: File | null;
  filePreview: FilePreview;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  selectedPattern: Pattern;
  setSelectedPattern: React.Dispatch<React.SetStateAction<Pattern>>;
}

export interface PatternTestResultsProps {
  pattern: string;
  customPatterns: Record<string, string>;
  logs: string[];
  parsedLogs?: Record<string, any>[];
  isLoading?: boolean;
  error?: string;
}

export interface LogPatternSelectionProps {
  initialPattern?: Pattern;
  onPatternChange: (pattern: Pattern) => void;
  previewLines: string[];
}

export interface AnalyzePatternProps {
  logs: string[];
  onDetectionComplete: (result: DetectionResult) => void;
  initialPattern?: Pattern;
}

export interface CustomPatternEditorProps {
  pattern: string;
  customPatterns: Record<string, string>;
  onPatternChange: (pattern: string) => void;
  onCustomPatternsChange: (patterns: Record<string, string>) => void;
}

// Props passed to a log-source provider component (currently only
// FileSelection, since CloudWatch was removed). Kept as a named type so
// callers don't have to inline-spell the callback signatures.
export interface LogSourceProvider {
  // Notify that a file has been selected by the user
  onFileSelect: (filename: string) => void;
  // Notify that a file preview component has been loaded
  onFilePreview: (lines: string[], filename: string) => void;
  // Notify that the user wants to step back from preview to source selection
  onBackToSourceSelection: () => void;
}

// Interface for log provider components that implement ref functionality
export interface LogSourceProviderService {
  name: string;
  // Start the actual import process
  handleFileImport: (filehandle: object, chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => Promise<void>;
  handleFilePreview: (filehandle: object, onPreviewReadyCallback: (lines: string[]) => void) => Promise<void>;
} 