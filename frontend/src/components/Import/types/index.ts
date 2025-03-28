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
  totalLines: number;
  fileSize: number;
}

export interface DetectionResult {
  isOngoing: boolean;
  suggestedPattern?: Pattern;
  parsedLogs?: Record<string, any>[];
  error?: string;
}


export interface FileSelectionProps {
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBackToSourceSelection?: () => void;
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
  handleUpload: () => Promise<void>;
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