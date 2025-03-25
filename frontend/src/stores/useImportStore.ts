import { create } from 'zustand';
import { 
  IngestSessionOptions, 
  SuggestResponse, 
  GrokPatternRequest 
} from '@/lib/api-types';
import { Pattern, FilePreview, DetectionResult } from '@/components/Import/types';
import { extractFields } from '../components/Import/utils/patternUtils';
import { parseLogs } from '@/lib/api-client';

// Default pattern to use if no pattern is detected


// Custom pattern option that will always be available
export const DEFAULT_PATTERN: Pattern = {
  name: "Custom Pattern",
  pattern: "%{GREEDYDATA:message}",
  description: "Creating a custom pattern",
  fields: ["message"],
  custom_patterns: {},
  priority: 0
};


export type UploadStep = 1 | 2 | 3;

interface ImportState {
  // Upload step tracking
  currentStep: UploadStep;
  
  // File data
  selectedFile: File | null;
  filePreview: FilePreview | null;

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
  parsedLogs: Record<string, any>[];
  isTestingPattern: boolean;
  
  // Upload status
  isUploading: boolean;
  uploadProgress: number;
  approxLines: number;
  
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
  
  // Actions
  setCurrentStep: (step: UploadStep) => void;
  setSelectedFile: (file: File | null) => void;
  setFilePreview: (preview: FilePreview | null) => void;
  setAvailablePatterns: (patterns: GrokPatternRequest[]) => void;
  setSelectedPattern: (pattern: Pattern | null) => void;
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
  setParsedLogs: (logs: Record<string, any>[]) => void;
  setIsTestingPattern: (isTestingPattern: boolean) => void;
  
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePatternOperation: (pattern: Pattern, updateStore?: boolean, onSuccess?: (parsedLogs: Record<string, any>[]) => void, onError?: (error: string) => void) => Promise<void>;
  testPattern: () => Promise<void>;
  reset: () => void;
}

/**
 * Store for managing import functionality
 * This store is NOT persisted and will be reset on page refresh
 */
export const useImportStore = create<ImportState>((set, get) => ({

  currentStep: 1,
  selectedFile: null,
  filePreview: null,
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
  selectedSources: [],
  sessionID: null,
  sessionOptionsFileName: '',
  sessionOptionsSmartDecoder: true,
  sessionOptionsTimezone: '',
  sessionOptionsYear: '',
  sessionOptionsMonth: '',
  sessionOptionsDay: '',
  error: null,
  
  // Actions
  setCurrentStep: (currentStep) => set({ currentStep }),
  
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  
  setFilePreview: (filePreview) => set({ filePreview }),
  
  setAvailablePatterns: (availablePatterns) => {
    // Always include the Custom Pattern option
    const patternsWithCustom = [
      DEFAULT_PATTERN as unknown as GrokPatternRequest,
      ...availablePatterns.filter(p => p.name !== DEFAULT_PATTERN.name)
    ];
    set({ availablePatterns: patternsWithCustom });
  },
  

  // Clear custom pattern selection if selected pattern is not custom
  setSelectedPattern: (selectedPattern) => {
    if (selectedPattern?.name !== DEFAULT_PATTERN.name) {
      set({ isCreateNewPatternSelected: false });
    }
    else {
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
  
  // Handle file selection and preview generation
  handleFileSelect: async (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;

    // Advanced content check for binary data and log structure
    const checkFileContent = (content: string): { isValid: boolean; errorMessage?: string } => {
      // Check for binary content by looking for NULL bytes or a high percentage of non-printable characters
      const controlChars = content.replace(/[\x20-\x7E\r\n\t]/g, '');
      const controlCharRatio = controlChars.length / content.length;
      
      // If more than 10% of characters are control characters, likely a binary file
      if (controlCharRatio > 0.1 || content.includes('\0')) {
        return { isValid: false, errorMessage: 'This appears to be a binary file and cannot be processed.' };
      }
      
      // Check if file has valid line structure (at least some non-empty lines)
      const lines = content.split('\n').filter(line => line.trim() !== '');
      if (lines.length === 0) {
        return { isValid: false, errorMessage: 'File is empty or contains no valid log lines.' };
      }
      
      return { isValid: true };
    };

    // Read the first portion of the file to check content
    const reader = new FileReader();
    const CONTENT_CHECK_SIZE = 8 * 1024; // 8KB is enough to detect binary content
    const contentBlob = file.slice(0, CONTENT_CHECK_SIZE);
    
    reader.onload = (e) => {
      const content = e.target?.result as string || '';
      const contentCheck = checkFileContent(content);
      
      if (!contentCheck.isValid) {
        set({ error: contentCheck.errorMessage || 'Invalid file content' });
        return;
      }
      
      // File passed validation, proceed with normal flow
      set({ selectedFile: file, error: null });

      // Read for preview with another reader
      const previewReader = new FileReader();
      const MAX_PREVIEW_SIZE = 10 * 1024; // 10KB
      const previewBlob = file.slice(0, MAX_PREVIEW_SIZE);
    
      previewReader.onload = (e) => {
        const previewContent = e.target?.result as string || '';
        const lines = previewContent.split('\n').filter(line => line.trim() !== '');
        const previewLines = lines.slice(0, 20); // Show first 20 lines
        
        // Count total lines (approximate for large files)
        const bytesPerLine = previewContent.length / (lines.length || 1);
        const approxTotalLines = Math.ceil(file.size / bytesPerLine);
        
        const filePreview = {
          lines: previewLines,
          totalLines: approxTotalLines,
          fileSize: file.size
        };
        
        set({ filePreview });
        
        // Automatically move to step 2 if a file is selected
        set({ currentStep: 2 });
      };
      
      previewReader.readAsText(previewBlob);
    };
    
    reader.readAsText(contentBlob);
  },
  
  // Simplified test pattern function
  testPattern: async () => {
    const { selectedPattern, handlePatternOperation } = get();
    
    if (!selectedPattern) return;
    
    set({ isTestingPattern: true, error: null });
    
    try {
      await handlePatternOperation(
        selectedPattern,
        false,
        (parsedLogs) => {
          set({ parsedLogs });
        },
        (error) => {
          set({ error });
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to test pattern';
      set({ error: errorMessage });
    } finally {
      set({ isTestingPattern: false });
    }
  },
  
  // Pattern operations
  handlePatternOperation: async (pattern: Pattern, updateStore: boolean = false, onSuccess?: (parsedLogs: Record<string, any>[]) => void, onError?: (error: string) => void) => {
    const {
      filePreview,
      sessionOptionsFileName,
      sessionOptionsSmartDecoder,
      sessionOptionsTimezone,
      sessionOptionsYear,
      sessionOptionsMonth,
      sessionOptionsDay,
      setSelectedPattern,
      setError,
      setParsedLogs
    } = get();

    // Add fields to the pattern if not already present
    const patternWithFields = {
      ...pattern,
      fields: pattern.fields || extractFields(pattern.pattern),
      custom_patterns: pattern.custom_patterns || {}
    };
    
    // Set the selected pattern in the store if updateStore is true
    if (updateStore) {
      setSelectedPattern(patternWithFields);
    }
    
    // Only analyze if we have a pattern and preview lines
    if (patternWithFields.pattern && filePreview?.lines?.length) {
      set({ error: null });
      
      try {
        const parseResponse = await parseLogs({
          logs: filePreview.lines,
          grok_pattern: patternWithFields.pattern,
          custom_patterns: patternWithFields.custom_patterns || {},
          session_options: {
            source: sessionOptionsFileName,
            smart_decoder: sessionOptionsSmartDecoder,
            force_timezone: sessionOptionsTimezone,
            force_start_year: sessionOptionsYear,
            force_start_month: sessionOptionsMonth,
            force_start_day: sessionOptionsDay
          }
        });
        
        if (parseResponse.logs) {
          // Update parsed logs in store
          setParsedLogs(parseResponse.logs);
          
          if (onSuccess) {
            onSuccess(parseResponse.logs);
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to parse logs with the selected pattern';
        setError(errorMessage);
        setParsedLogs([]);
        if (onError) {
          onError(errorMessage);
        }
      }
    }
  },
  
  reset: () => set({
    currentStep: 1,
    selectedFile: null,
    filePreview: null,
    selectedPattern: DEFAULT_PATTERN,
    createNewPattern: DEFAULT_PATTERN,
    isCreateNewPatternSelected: false,
    detectionResult: null,
    suggestResponse: null,
    parsedLogs: [],
    isTestingPattern: false,
    isUploading: false,
    uploadProgress: 0,
    approxLines: 0,
    error: null,
    sessionID: null,
    // Keep available patterns to avoid refetching
    availablePatterns: [DEFAULT_PATTERN as unknown as GrokPatternRequest, ...get().availablePatterns.filter(p => p.name !== DEFAULT_PATTERN.name)],
    // Keep session options as they might be user preferences
    sessionOptionsFileName: '',
    sessionOptionsSmartDecoder: true,
    sessionOptionsTimezone: '',
    sessionOptionsYear: '', 
    sessionOptionsMonth: '',
    sessionOptionsDay: '',
  }),

})); 