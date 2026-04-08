import { DetectionResult, FilePreview, FileSessionOptions, ImportFile, Pattern } from '@/components/Import/types';
import { parseLogs } from '@/lib/api-client';
import {
  GrokPatternRequest,
  IngestSessionOptions,
  SuggestResponse
} from '@/lib/api-types';
import { create } from 'zustand';

// Default pattern to use if no pattern is detected
export const DEFAULT_PATTERN: Pattern = {
  name: "Custom Pattern",
  pattern: "%{GREEDYDATA:message}",
  description: "Creating a custom pattern",
  fields: ["message"],
  custom_patterns: {},
  priority: 0
};

export const DEFAULT_SESSION_OPTIONS: FileSessionOptions = {
  smartDecoder: true,
  timezone: '',
  year: '',
  month: '',
  day: '',
};

// Add a type for the provider upload handler
export type ProviderUploadHandler = (handleImport: (chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => Promise<void>) => Promise<void>;

export type UploadStep = 1 | 2 | 3 | 4;
export type ImportSource = string | null;

let fileIdCounter = 0;
export function generateFileId(): string {
  return `file-${Date.now()}-${++fileIdCounter}`;
}

interface ImportState {
  // Upload step tracking
  currentStep: UploadStep;

  // Import source name
  importSource: ImportSource;

  readyToSelectPattern: boolean;
  readyToImportLogs: boolean;

  // --- Multi-file state ---
  files: ImportFile[];
  activeFileId: string | null; // Which file is currently being configured in detail

  // --- Legacy single-file state (kept for CloudWatch compatibility) ---
  selectedFileName: string | null;
  selectedFileHandle: object | null;
  filePreviewBuffer: FilePreview | null;

  // Pattern data
  availablePatterns: GrokPatternRequest[];
  selectedPattern: Pattern | null;
  isCreateNewPatternSelected: boolean;
  createNewPattern: Pattern;
  createNewPatternTokens: Record<string, string>;
  createNewPatternName: string;
  createNewPatternDescription: string;
  createNewPatternPriority: number;

  // Detection results
  detectionResult: DetectionResult | null;
  suggestResponse: SuggestResponse | null;

  // Parsed logs data
  parsedLogs: Record<string, string>[];
  isTestingPattern: boolean;

  // Upload status
  isUploading: boolean;
  uploadProgress: number;
  approxLines: number;
  totalLines: number;

  // Source selection
  selectedSources: string[];

  // Ingest session
  sessionID: string | null;
  sessionOptionsFileName: string;
  sessionOptionsSmartDecoder: boolean;
  sessionOptionsTimezone: string;
  sessionOptionsYear: string;
  sessionOptionsMonth: string;
  sessionOptionsDay: string;

  // Error handling
  error: string | null;

  // Metadata
  metadata: Record<string, string | number | boolean>;
  providerUploadHandler: ProviderUploadHandler | null;

  // --- Multi-file actions ---
  addFiles: (newFiles: File[]) => void;
  removeFile: (fileId: string) => void;
  setActiveFileId: (fileId: string | null) => void;
  updateFile: (fileId: string, updates: Partial<ImportFile>) => void;
  updateFilePattern: (fileId: string, pattern: Pattern) => void;
  updateFileSessionOptions: (fileId: string, options: Partial<FileSessionOptions>) => void;
  setAllFilesPattern: (pattern: Pattern) => void;
  getActiveFile: () => ImportFile | null;

  // --- Legacy actions ---
  setCurrentStep: (step: UploadStep) => void;
  setImportSource: (source: ImportSource) => void;
  setSelectedFileName: (filename: string | null) => void;
  setSelectedFileHandle: (fileHandle: any | null) => void;
  setFilePreviewBuffer: (preview: FilePreview | null) => void;
  setAvailablePatterns: (patterns: GrokPatternRequest[]) => void;
  setSelectedPattern: (pattern: Pattern | null) => void;
  setReadyToImportLogs: (ready: boolean) => void;
  setCreateNewPattern: (pattern: Pattern) => void;
  setCreateNewPatternTokens: (tokens: Record<string, string>) => void;
  setCreateNewPatternName: (name: string) => void;
  setCreateNewPatternDescription: (description: string) => void;
  setCreateNewPatternPriority: (priority: number) => void;
  setDetectionResult: (result: DetectionResult | null) => void;
  setSuggestResponse: (response: SuggestResponse | null) => void;
  setIsUploading: (isUploading: boolean) => void;
  setUploadProgress: (progress: number) => void;
  setApproxLines: (lines: number) => void;
  setSelectedSources: (sources: string[]) => void;
  setSessionID: (sessionID: string | null) => void;
  setSessionOptionFileName: (fileName: string) => void;
  setSessionOptionSmartDecoder: (smartDecoder: boolean) => void;
  setSessionOptionTimezone: (timezone: string) => void;
  setSessionOptionYear: (year: string) => void;
  setSessionOptionMonth: (month: string) => void;
  setSessionOptionDay: (day: string) => void;
  setError: (error: string | null) => void;
  setParsedLogs: (logs: Record<string, string>[]) => void;
  setIsTestingPattern: (isTestingPattern: boolean) => void;
  setMetadata: (metadata: Record<string, string | number | boolean>) => void;
  setReadyToSelectPattern: (ready: boolean) => void;
  setFileFromBlob: (content: string, fileName: string) => Promise<void>;
  handlePatternOperation: (pattern: Pattern, updateStore?: boolean, onSuccess?: (parsedLogs: Record<string, string>[]) => void, onError?: (error: string) => void) => Promise<void>;
  testPattern: () => Promise<void>;
  reset: () => void;
  setTotalLines: (totalLines: number) => void;
  setProviderUploadHandler: (handler: ProviderUploadHandler | null) => void;
}

/**
 * Store for managing import functionality
 * This store is NOT persisted and will be reset on page refresh
 */
export const useImportStore = create<ImportState>((set, get) => ({

  currentStep: 1,
  importSource: null,
  selectedFileName: null,
  selectedFileHandle: null,
  filePreviewBuffer: null,
  readyToSelectPattern: false,
  readyToImportLogs: false,
  availablePatterns: [DEFAULT_PATTERN as unknown as GrokPatternRequest],
  selectedPattern: DEFAULT_PATTERN,
  createNewPattern: DEFAULT_PATTERN,
  isCreateNewPatternSelected: false,
  createNewPatternTokens: {},
  createNewPatternName: DEFAULT_PATTERN.name,
  createNewPatternDescription: DEFAULT_PATTERN.description,
  createNewPatternPriority: DEFAULT_PATTERN.priority,
  detectionResult: null,
  suggestResponse: null,
  parsedLogs: [],
  isTestingPattern: false,
  isUploading: false,
  uploadProgress: 0,
  approxLines: 0,
  totalLines: 0,
  selectedSources: [],
  sessionID: null,
  sessionOptionsFileName: '',
  sessionOptionsSmartDecoder: true,
  sessionOptionsTimezone: '',
  sessionOptionsYear: '',
  sessionOptionsMonth: '',
  sessionOptionsDay: '',
  error: null,
  metadata: {},
  providerUploadHandler: null,

  // Multi-file state
  files: [],
  activeFileId: null,

  // --- Multi-file actions ---

  addFiles: (newFiles: File[]) => {
    const importFiles: ImportFile[] = newFiles.map(file => ({
      id: generateFileId(),
      file,
      fileName: file.name,
      fileSize: file.size,
      previewLines: [],
      approxLines: 0,
      detectedPattern: null,
      selectedPattern: null,
      isCustomPattern: false,
      customPattern: null,
      customPatternTokens: {},
      detectionStatus: 'pending',
      detectionError: null,
      parsedLogs: [],
      uploadStatus: 'pending',
      uploadProgress: 0,
      uploadError: null,
      totalLinesProcessed: 0,
      sessionOptions: { ...DEFAULT_SESSION_OPTIONS },
    }));
    set(state => ({ files: [...state.files, ...importFiles] }));
  },

  removeFile: (fileId: string) => {
    set(state => ({
      files: state.files.filter(f => f.id !== fileId),
      activeFileId: state.activeFileId === fileId ? null : state.activeFileId,
    }));
  },

  setActiveFileId: (fileId: string | null) => set({ activeFileId: fileId }),

  updateFile: (fileId: string, updates: Partial<ImportFile>) => {
    set(state => ({
      files: state.files.map(f => f.id === fileId ? { ...f, ...updates } : f),
    }));
  },

  updateFilePattern: (fileId: string, pattern: Pattern) => {
    set(state => ({
      files: state.files.map(f =>
        f.id === fileId
          ? { ...f, selectedPattern: pattern, isCustomPattern: pattern.name === DEFAULT_PATTERN.name }
          : f
      ),
    }));
  },

  updateFileSessionOptions: (fileId: string, options: Partial<FileSessionOptions>) => {
    set(state => ({
      files: state.files.map(f =>
        f.id === fileId
          ? { ...f, sessionOptions: { ...f.sessionOptions, ...options } }
          : f
      ),
    }));
  },

  setAllFilesPattern: (pattern: Pattern) => {
    set(state => ({
      files: state.files.map(f => ({
        ...f,
        selectedPattern: pattern,
        isCustomPattern: pattern.name === DEFAULT_PATTERN.name,
      })),
    }));
  },

  getActiveFile: () => {
    const { files, activeFileId } = get();
    return files.find(f => f.id === activeFileId) || null;
  },

  // --- Legacy actions (unchanged) ---
  setCurrentStep: (currentStep) => set({ currentStep }),
  setImportSource: (importSource) => set({ importSource }),
  setSelectedFileName: (selectedFileName) => set({ selectedFileName }),
  setSelectedFileHandle: (selectedFileHandle) => set({ selectedFileHandle }),
  setFilePreviewBuffer: (filePreviewBuffer) => set({ filePreviewBuffer }),
  setReadyToSelectPattern: (readyToSelectPattern) => set({ readyToSelectPattern }),
  setReadyToImportLogs: (readyToImportLogs) => set({ readyToImportLogs }),

  setAvailablePatterns: (availablePatterns) => {
    const patternsWithCustom = [
      DEFAULT_PATTERN as unknown as GrokPatternRequest,
      ...availablePatterns.filter(p => p.name !== DEFAULT_PATTERN.name)
    ];
    set({ availablePatterns: patternsWithCustom });
  },

  setSelectedPattern: (selectedPattern) => {
    if (selectedPattern?.name !== DEFAULT_PATTERN.name) {
      set({ isCreateNewPatternSelected: false });
    } else {
      set({ isCreateNewPatternSelected: true });
    }
    set({ selectedPattern });
  },

  setCreateNewPatternName: (name: string) => set({ createNewPatternName: name }),
  setCreateNewPatternDescription: (description: string) => set({ createNewPatternDescription: description }),
  setCreateNewPatternPriority: (priority: number) => set({ createNewPatternPriority: priority }),
  setCreateNewPattern: (createNewPattern = DEFAULT_PATTERN) => {
    set({ createNewPattern });
    set({ isCreateNewPatternSelected: true });
  },

  setCreateNewPatternTokens: (tokens: Record<string, string>) => set({ createNewPatternTokens: tokens }),
  setDetectionResult: (detectionResult) => set({ detectionResult }),
  setSuggestResponse: (suggestResponse) => set({ suggestResponse }),
  setIsUploading: (isUploading) => set({ isUploading }),
  setUploadProgress: (uploadProgress) => set({ uploadProgress }),
  setApproxLines: (approxLines) => set({ approxLines }),
  setTotalLines: (totalLines) => set({ totalLines }),
  setSelectedSources: (selectedSources) => set({ selectedSources }),
  setSessionID: (sessionID) => set({ sessionID }),
  setSessionOptionFileName: (fileName: string) => set({ sessionOptionsFileName: fileName }),
  setSessionOptionSmartDecoder: (smartDecoder: boolean) => set({ sessionOptionsSmartDecoder: smartDecoder }),
  setSessionOptionTimezone: (timezone: string) => set({ sessionOptionsTimezone: timezone }),
  setSessionOptionYear: (year: string) => set({ sessionOptionsYear: year }),
  setSessionOptionMonth: (month: string) => set({ sessionOptionsMonth: month }),
  setSessionOptionDay: (day: string) => set({ sessionOptionsDay: day }),
  setError: (error) => set({ error }),
  setParsedLogs: (parsedLogs) => set({ parsedLogs }),
  setIsTestingPattern: (isTestingPattern) => set({ isTestingPattern }),

  setFileFromBlob: async (content, fileName) => {
    console.log(`Setting file from blob: ${fileName}, content length: ${content.length} bytes`);
    const file = new File([content], fileName, { type: 'text/plain' });

    if (!content || content.length === 0) {
      const error = "Empty content provided for CloudWatch logs";
      console.error(error);
      set({ error });
      return;
    }

    const previewLines = content.split('\n');
    const approxLines = previewLines.length;

    set({
      filePreviewBuffer: {
        lines: previewLines.slice(0, 100),
        filename: fileName,
      },
      approxLines,
      sessionOptionsFileName: fileName,
      currentStep: 2
    });
  },

  handlePatternOperation: async (pattern, updateStore = true, onSuccess, onError) => {
    const {
      selectedFileName,
      filePreviewBuffer,
      sessionOptionsSmartDecoder,
      sessionOptionsTimezone,
      sessionOptionsYear,
      sessionOptionsMonth,
      sessionOptionsDay,
      importSource,
      metadata
    } = get();

    if (!selectedFileName || !filePreviewBuffer) {
      const errorMsg = 'No file selected or file preview not available';
      set({ error: errorMsg });
      if (onError) onError(errorMsg);
      return;
    }

    set({ isTestingPattern: true, error: null });

    try {
      if (!filePreviewBuffer.lines || filePreviewBuffer.lines.length === 0) {
        throw new Error('No preview lines available to parse');
      }

      const previewLines = filePreviewBuffer.lines.slice(0, 20);

      const sessionOptions: IngestSessionOptions = {
        name: pattern.name,
        pattern: pattern.pattern,
        priority: pattern.priority,
        custom_patterns: pattern.custom_patterns,
        source: importSource,
        smart_decoder: sessionOptionsSmartDecoder,
        force_timezone: sessionOptionsTimezone,
        force_start_year: sessionOptionsYear,
        force_start_month: sessionOptionsMonth,
        force_start_day: sessionOptionsDay,
        meta: metadata
      };

      const parseResult = await parseLogs({
        logs: previewLines,
        grok_pattern: pattern.pattern,
        custom_patterns: pattern.custom_patterns || {},
        session_options: sessionOptions
      });

      const parsedLogs = parseResult.logs || [];

      if (updateStore) {
        set({ parsedLogs, selectedPattern: pattern });
      }

      if (onSuccess) onSuccess(parsedLogs);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to test pattern';
      set({ error: errorMsg });
      if (onError) onError(errorMsg);
    } finally {
      set({ isTestingPattern: false });
    }
  },

  testPattern: async () => {
    const { selectedPattern, isCreateNewPatternSelected, createNewPattern } = get();
    const pattern = isCreateNewPatternSelected ? createNewPattern : selectedPattern;

    if (!pattern) {
      set({ error: 'No pattern selected' });
      return;
    }

    await get().handlePatternOperation(pattern);
  },

  setMetadata: (metadata: Record<string, string | number | boolean>) => set({ metadata }),

  reset: () => {
    console.log("Resetting import store");
    set({
      currentStep: 1,
      importSource: null,
      selectedFileName: null,
      selectedFileHandle: null,
      filePreviewBuffer: null,
      selectedPattern: DEFAULT_PATTERN,
      isCreateNewPatternSelected: false,
      createNewPattern: DEFAULT_PATTERN,
      createNewPatternTokens: {},
      createNewPatternName: DEFAULT_PATTERN.name,
      createNewPatternDescription: DEFAULT_PATTERN.description,
      createNewPatternPriority: DEFAULT_PATTERN.priority,
      detectionResult: null,
      suggestResponse: null,
      parsedLogs: [],
      isTestingPattern: false,
      isUploading: false,
      uploadProgress: 0,
      approxLines: 0,
      selectedSources: [],
      sessionID: null,
      sessionOptionsFileName: '',
      sessionOptionsSmartDecoder: true,
      sessionOptionsTimezone: '',
      sessionOptionsYear: '',
      sessionOptionsMonth: '',
      sessionOptionsDay: '',
      error: null,
      providerUploadHandler: null,
      files: [],
      activeFileId: null,
    });
  },

  setProviderUploadHandler: (handler: ProviderUploadHandler | null) => {
    set({ providerUploadHandler: handler || null });
  },
}));
