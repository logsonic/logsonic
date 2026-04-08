// Types for the Import functionality

export type UploadStep = 1 | 2 | 3 | 4;

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
  handleUpload: (provider: LogSourceProviderService) => Promise<void>;
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

// Interface for log source providers
export interface LogSourceProvider {
  id: string;
  name: string;
  icon: React.ComponentType<any>;
  component: React.ForwardRefExoticComponent<any>;
  // callbacks for notifying file selection and preview

  // Notify that a file has been selected from the user
  onFileSelect: (filename: string) => void;
  // Notify that a file preview component has been loaded
  onFilePreview: (lines: string[], filename: string) => void;
  // Notify that the user wants to go back to the source selection after file preview
  onBackToSourceSelection: () => void;
  // Notify that the wizard can proceed to file analysis
  onFileReadyForAnalysis: (ready: boolean) => void;
}

// Interface for log provider components that implement ref functionality
export interface LogSourceProviderService {
  name: string;
  // Start the actual import process
  handleFileImport: (filehandle: object, chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => Promise<void>;
  handleFilePreview: (filehandle: object, onPreviewReadyCallback: (lines: string[]) => void) => Promise<void>;
} 