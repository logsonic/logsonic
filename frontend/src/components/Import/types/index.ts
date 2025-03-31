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
  handleFileImport: (filename: string, filehandle: File, chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => Promise<void>;
  handleFilePreview: (file: File, onPreviewReadyCallback: (lines: string[]) => void) => Promise<void>;
} 