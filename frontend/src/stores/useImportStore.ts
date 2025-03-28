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
export type ImportSource = string | null;

interface ImportState {
  // Upload step tracking
  currentStep: UploadStep;
  
  // Import source
  importSource: ImportSource;
  readyToSelectPattern: boolean;
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
  
  // Metadata
  metadata: Record<string, any>;
  
  // Actions
  setCurrentStep: (step: UploadStep) => void;
  setImportSource: (source: ImportSource) => void;
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
  setMetadata: (metadata: Record<string, any>) => void;
  setReadyToSelectPattern: (ready: boolean) => void;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  setFileFromBlob: (content: string, fileName: string) => Promise<void>;
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
  importSource: null,
  selectedFile: null,
  filePreview: null,
  readyToSelectPattern: false,

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
  metadata: {},
  
  // Actions
  setCurrentStep: (currentStep) => set({ currentStep }),
  
  setImportSource: (importSource) => set({ importSource }),
  
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setReadyToSelectPattern: (readyToSelectPattern) => set({ readyToSelectPattern }),
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
        const previewLines = previewContent.split('\n');
        
        // Calculate an approximation of total lines based on the average line size in the preview
        const avgLineSize = previewContent.length / (previewLines.length || 1);
        const approxLines = Math.ceil(file.size / avgLineSize);
        
        set({ 
          filePreview: {
            lines: previewLines.slice(0, 100), // Limit display lines to 100
            totalLines: previewLines.length,
            fileSize: file.size,
          },
          approxLines,
        });
        
        // Go to the next step automatically if on step 1
        if (get().currentStep === 1) {
          set({ 
            currentStep: 2,
            importSource: 'file'
          });
        }
      };
      
      previewReader.readAsText(previewBlob);
    };
    
    reader.readAsText(contentBlob);
  },

  // Create a file from blob content (used for CloudWatch logs)
  setFileFromBlob: async (content, fileName) => {
    console.log(`Setting file from blob: ${fileName}, content length: ${content.length} bytes`);
    
    // Create a File object
    const file = new File([content], fileName, { type: 'text/plain' });
    
    // Set selected file
    set({ 
      selectedFile: file, 
      error: null,
      importSource: 'cloudwatch'
    });
    
    // Validate file content
    if (!content || content.length === 0) {
      const error = "Empty content provided for CloudWatch logs";
      console.error(error);
      set({ error });
      return;
    }

    // Generate preview
    const previewLines = content.split('\n');
    const approxLines = previewLines.length;
    
    console.log(`Generated preview with ${previewLines.length} lines, using first ${Math.min(100, previewLines.length)} for display`);
    
    // Set preview data and move to step 2
    set({ 
      filePreview: {
        lines: previewLines.slice(0, 100), // Limit display lines to 100
        totalLines: previewLines.length,
        fileSize: content.length,
      },
      approxLines,
      sessionOptionsFileName: fileName, // Set the filename for the session
      currentStep: 2 // Ensure we move to step 2 for pattern detection
    });
    
    console.log("CloudWatch logs ready for pattern detection, advancing to step 2");
  },
  
  // Handle pattern operations
  handlePatternOperation: async (pattern, updateStore = true, onSuccess, onError) => {
    const { selectedFile, filePreview } = get();
    
    if (!selectedFile || !filePreview) {
      const errorMsg = 'No file selected or file preview not available';
      set({ error: errorMsg });
      if (onError) onError(errorMsg);
      return;
    }
    
    set({ isTestingPattern: true });
    
    try {
      if (!filePreview.lines || filePreview.lines.length === 0) {
        throw new Error('No preview lines available to parse');
      }
      
      const previewLines = filePreview.lines.slice(0, 20); // Use first 20 lines for parsing test
      
      const parseResult = await parseLogs({
        logs: previewLines,
        grok_pattern: pattern.pattern,
        custom_patterns: pattern.custom_patterns || {},
      });
      
      const parsedLogs = parseResult.logs || [];
      
      if (updateStore) {
        set({ 
          parsedLogs,
          selectedPattern: pattern,
        });
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

  // Test the current pattern
  testPattern: async () => {
    const { selectedPattern, isCreateNewPatternSelected, createNewPattern } = get();
    
    const pattern = isCreateNewPatternSelected ? createNewPattern : selectedPattern;
    
    if (!pattern) {
      set({ error: 'No pattern selected' });
      return;
    }
    
    await get().handlePatternOperation(pattern);
  },
    setMetadata: (metadata: Record<string, any>) => set({ metadata }),

  // Reset the store to default values
  reset: () => {
    set({
      currentStep: 1,
      importSource: null,
      selectedFile: null,
      filePreview: null,
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
    });
  },
})) 