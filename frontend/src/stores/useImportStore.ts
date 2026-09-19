import { DetectionResult, FilePreview, FileSessionOptions, ImportFile, Pattern } from '@/components/Import/types';
import { parseLogs } from '@/lib/api-client';
import {
  GrokPatternRequest,
  IngestSessionOptions,
  MultilineConfig,
  SuggestResponse,
  TimestampInference,
  TimestampResolution
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

export function sessionMultilineOption(state: {
  sessionOptionsMultilineEnabled: boolean;
  sessionOptionsMultilineMode: 'header' | 'indent';
  sessionOptionsMultilineHeaderPattern: string;
}): MultilineConfig | undefined {
  if (!state.sessionOptionsMultilineEnabled) return undefined;
  return {
    enabled: true,
    mode: state.sessionOptionsMultilineMode,
    header_pattern: state.sessionOptionsMultilineHeaderPattern || undefined,
  };
}

export function isMultilineHeaderInvalid(state: {
  sessionOptionsMultilineEnabled: boolean;
  sessionOptionsMultilineMode: 'header' | 'indent';
  sessionOptionsMultilineHeaderPattern: string;
}): boolean {
  return state.sessionOptionsMultilineEnabled
    && state.sessionOptionsMultilineMode === 'header'
    && !state.sessionOptionsMultilineHeaderPattern.trim();
}

// Add a type for the provider upload handler
export type ProviderUploadHandler = (handleImport: (chunkSize: number, callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>) => Promise<void>) => Promise<void>;

export type ImportSource = string | null;

let fileIdCounter = 0;
export function generateFileId(): string {
  return `file-${Date.now()}-${++fileIdCounter}`;
}

// The browser has no path.basename; a native path can be POSIX or Windows
// (spec now-08 requires both to work), so split on either separator.
export function basenameOfPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export type DetailTab = 'pattern' | 'timestamp' | 'options';

interface ImportState {
  // Import source name
  importSource: ImportSource;

  // --- Multi-file state ---
  files: ImportFile[];
  // The file whose preview is shown (the selected row). Also the file
  // the SavePatternDialog captures a timestamp resolution from.
  activeFileId: string | null;
  // Non-null while the per-file detail panel replaces the file list.
  detailPanelFileId: string | null;
  detailTab: DetailTab;
  // Upload-progress UI: whether the per-file rows are expanded.
  isExpandedPerFileDetails: boolean;

  // --- Legacy single-file state ---
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
  sessionOptionsMultilineEnabled: boolean;
  sessionOptionsMultilineMode: 'header' | 'indent';
  sessionOptionsMultilineHeaderPattern: string;

  // Timestamp resolution: inference comes from /parse, overrides are
  // user-edited knob values. The effective resolution sent to ingest
  // is { ...inference.resolution, ...timestampOverrides }. Confirmed
  // is set true once the user accepts (auto-true for status="exact").
  timestampInference: TimestampInference | null;
  timestampOverrides: Partial<TimestampResolution>;
  timestampConfirmed: boolean;
  sourceMTime: string | null; // RFC3339, set during file selection

  // Error handling
  error: string | null;

  // Metadata
  metadata: Record<string, string | number | boolean>;
  providerUploadHandler: ProviderUploadHandler | null;

  // --- Multi-file actions ---
  addFiles: (newFiles: File[]) => void;
  addNativePathFiles: (paths: string[], mtimes?: (string | null)[]) => void;
  removeFile: (fileId: string) => void;
  setActiveFileId: (fileId: string | null) => void;
  updateFile: (fileId: string, updates: Partial<ImportFile>) => void;
  updateFilePattern: (fileId: string, pattern: Pattern) => void;
  updateFileSessionOptions: (fileId: string, options: Partial<FileSessionOptions>) => void;
  setAllFilesPattern: (pattern: Pattern) => void;
  setAllFilesOptions: (options: FileSessionOptions) => void;
  getActiveFile: () => ImportFile | null;
  openFileDetail: (fileId: string) => void;
  closeFileDetail: () => void;
  setDetailTab: (tab: DetailTab) => void;
  togglePerFileDetails: () => void;

  // Per-file timestamp resolution actions. The TimestampPanel writes
  // through these in multi-file mode so each file keeps its own
  // anchor and overrides. Confirmed flips back to false on every
  // override change so an ambiguous/missing status can't slip past
  // the navigation gate after a user knob change.
  setFileTimestampInference: (fileId: string, inference: TimestampInference | null) => void;
  patchFileTimestampOverride: (fileId: string, patch: Partial<TimestampResolution>) => void;
  setFileTimestampOverrides: (fileId: string, overrides: Partial<TimestampResolution>) => void;
  setFileTimestampConfirmed: (fileId: string, confirmed: boolean) => void;
  setFileSourceMTime: (fileId: string, mtime: string | null) => void;
  applyTimestampToAllFiles: (sourceFileId: string) => void;

  // --- Legacy actions ---
  setImportSource: (source: ImportSource) => void;
  setSelectedFileName: (filename: string | null) => void;
  setSelectedFileHandle: (fileHandle: any | null) => void;
  setFilePreviewBuffer: (preview: FilePreview | null) => void;
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
  setSessionOptionMultilineEnabled: (enabled: boolean) => void;
  setSessionOptionMultilineMode: (mode: 'header' | 'indent') => void;
  setSessionOptionMultilineHeaderPattern: (pattern: string) => void;
  setTimestampInference: (inference: TimestampInference | null) => void;
  setTimestampOverrides: (overrides: Partial<TimestampResolution>) => void;
  patchTimestampOverride: (patch: Partial<TimestampResolution>) => void;
  setTimestampConfirmed: (confirmed: boolean) => void;
  setSourceMTime: (mtime: string | null) => void;
  setError: (error: string | null) => void;
  setParsedLogs: (logs: Record<string, string>[]) => void;
  setIsTestingPattern: (isTestingPattern: boolean) => void;
  setMetadata: (metadata: Record<string, string | number | boolean>) => void;
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

  importSource: null,
  selectedFileName: null,
  selectedFileHandle: null,
  filePreviewBuffer: null,
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
  sessionOptionsMultilineEnabled: false,
  sessionOptionsMultilineMode: 'header',
  sessionOptionsMultilineHeaderPattern: '',
  timestampInference: null,
  timestampOverrides: {},
  timestampConfirmed: false,
  sourceMTime: null,
  error: null,
  metadata: {},
  providerUploadHandler: null,

  // Multi-file state
  files: [],
  activeFileId: null,
  detailPanelFileId: null,
  detailTab: 'pattern',
  isExpandedPerFileDetails: false,

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
      timestampInference: null,
      timestampOverrides: {},
      timestampConfirmed: false,
      // Browser File API exposes lastModified as ms since epoch. Capture
      // it here so the resolver can anchor against the file's mtime
      // instead of falling back to wall-clock now.
      sourceMTime: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    }));
    set(state => ({ files: [...state.files, ...importFiles] }));
  },

  // Native-path files (spec now-08 phase 5's FileSelection.tsx wiring is
  // the only intended caller): fileSize/previewLines/approxLines are left
  // at zero/empty here since getting them means an extra request
  // (POST /parse/preview-file) the caller makes once, not per store call.
  // `mtimes[i]` (already ISO 8601, from the macOS shell's own stat() of
  // the path -- the browser has none) anchors year-less/2-digit-year
  // timestamps the same way a browser File's lastModified does; missing
  // or shorter than `paths` falls back to null per entry, same as before.
  addNativePathFiles: (paths: string[], mtimes?: (string | null)[]) => {
    const importFiles: ImportFile[] = paths.map((path, i) => ({
      id: generateFileId(),
      nativePath: path,
      fileName: basenameOfPath(path),
      fileSize: 0,
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
      timestampInference: null,
      timestampOverrides: {},
      timestampConfirmed: false,
      sourceMTime: mtimes?.[i] ?? null,
    }));
    set(state => ({ files: [...state.files, ...importFiles] }));
  },

  removeFile: (fileId: string) => {
    set((state) => ({
      files: state.files.filter((f) => f.id !== fileId),
      activeFileId: state.activeFileId === fileId ? null : state.activeFileId,
      detailPanelFileId: state.detailPanelFileId === fileId ? null : state.detailPanelFileId,
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

  setAllFilesOptions: (options: FileSessionOptions) => {
    set((state) => ({
      files: state.files.map((f) => ({ ...f, sessionOptions: { ...options } })),
    }));
  },

  getActiveFile: () => {
    const { files, activeFileId } = get();
    return files.find(f => f.id === activeFileId) || null;
  },

  // Opening a file's detail also selects it, so the preview pane and the
  // panel always describe the same file. The tab resets to Pattern on
  // every open (per the handoff), not per file.
  openFileDetail: (fileId: string) =>
    set({ detailPanelFileId: fileId, activeFileId: fileId, detailTab: 'pattern' }),
  closeFileDetail: () => set({ detailPanelFileId: null }),
  setDetailTab: (detailTab: DetailTab) => set({ detailTab }),
  togglePerFileDetails: () =>
    set((state) => ({ isExpandedPerFileDetails: !state.isExpandedPerFileDetails })),

  setFileTimestampInference: (fileId, inference) => {
    // status="exact" means no user intervention is needed; auto-confirm
    // so the navigation gate doesn't block at step 2.
    const confirmed = inference?.status === 'exact';
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, timestampInference: inference, timestampConfirmed: confirmed }
        : f),
    }));
  },

  patchFileTimestampOverride: (fileId, patch) => {
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? {
            ...f,
            timestampOverrides: { ...f.timestampOverrides, ...patch },
            // Any knob change voids prior confirmation — the user has
            // to re-look at the preview before proceeding.
            timestampConfirmed: false,
          }
        : f),
    }));
  },

  setFileTimestampOverrides: (fileId, timestampOverrides) => {
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, timestampOverrides, timestampConfirmed: false }
        : f),
    }));
  },

  setFileTimestampConfirmed: (fileId, timestampConfirmed) => {
    set(state => ({
      files: state.files.map(f => f.id === fileId ? { ...f, timestampConfirmed } : f),
    }));
  },

  setFileSourceMTime: (fileId, sourceMTime) => {
    set(state => ({
      files: state.files.map(f => f.id === fileId ? { ...f, sourceMTime } : f),
    }));
  },

  applyTimestampToAllFiles: (sourceFileId) => {
    const src = get().files.find(f => f.id === sourceFileId);
    if (!src) return;
    set(state => ({
      files: state.files.map(f => f.id === sourceFileId
        ? f
        : {
            ...f,
            // Clone the source's overrides; keep each file's own
            // inference (sniffed against its own sample) so the
            // diagnostic chip reflects that file's actual layout.
            timestampOverrides: { ...src.timestampOverrides },
            // Honour the source's confirmation only if a confirmation
            // was actually given — never auto-confirm a 'missing' file
            // just because the source happened to match.
            timestampConfirmed: src.timestampConfirmed && f.timestampInference?.status !== 'missing',
          }),
    }));
  },

  // --- Legacy actions (unchanged) ---
  setImportSource: (importSource) => set({ importSource }),
  setSelectedFileName: (selectedFileName) => set({ selectedFileName }),
  setSelectedFileHandle: (selectedFileHandle) => set({ selectedFileHandle }),
  setFilePreviewBuffer: (filePreviewBuffer) => set({ filePreviewBuffer }),

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
  setSessionOptionMultilineEnabled: (enabled: boolean) => set({ sessionOptionsMultilineEnabled: enabled }),
  setSessionOptionMultilineMode: (mode: 'header' | 'indent') => set({ sessionOptionsMultilineMode: mode }),
  setSessionOptionMultilineHeaderPattern: (pattern: string) => set({ sessionOptionsMultilineHeaderPattern: pattern }),
  setTimestampInference: (timestampInference) => {
    // status="exact" means no user intervention is needed — auto-confirm
    // so the wizard's gating logic doesn't block at step 3.
    const confirmed = timestampInference?.status === 'exact';
    set({ timestampInference, timestampConfirmed: confirmed });
  },
  setTimestampOverrides: (timestampOverrides) => set({ timestampOverrides, timestampConfirmed: false }),
  patchTimestampOverride: (patch) => set(state => ({
    timestampOverrides: { ...state.timestampOverrides, ...patch },
    timestampConfirmed: false,
  })),
  setTimestampConfirmed: (timestampConfirmed) => set({ timestampConfirmed }),
  setSourceMTime: (sourceMTime) => set({ sourceMTime }),
  setError: (error) => set({ error }),
  setParsedLogs: (parsedLogs) => set({ parsedLogs }),
  setIsTestingPattern: (isTestingPattern) => set({ isTestingPattern }),

  handlePatternOperation: async (pattern, updateStore = true, onSuccess, onError) => {
    const {
      selectedFileName,
      filePreviewBuffer,
      sessionOptionsSmartDecoder,
      sessionOptionsTimezone,
      sessionOptionsYear,
      sessionOptionsMonth,
      sessionOptionsDay,
      sourceMTime,
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
        source_mtime: sourceMTime || undefined,
        meta: metadata,
        multiline: sessionMultilineOption(get()),
      };

      const parseResult = await parseLogs({
        logs: previewLines,
        grok_pattern: pattern.pattern,
        custom_patterns: pattern.custom_patterns || {},
        session_options: sessionOptions
      });

      const parsedLogs = parseResult.logs || [];

      if (updateStore) {
        const inf = parseResult.timestamp_inference || null;
        set({
          parsedLogs,
          selectedPattern: pattern,
          timestampInference: inf,
          timestampOverrides: {},
          timestampConfirmed: inf?.status === 'exact',
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
      sessionOptionsMultilineEnabled: false,
      sessionOptionsMultilineMode: 'header',
      sessionOptionsMultilineHeaderPattern: '',
      timestampInference: null,
      timestampOverrides: {},
      timestampConfirmed: false,
      sourceMTime: null,
      error: null,
      providerUploadHandler: null,
      files: [],
      activeFileId: null,
      detailPanelFileId: null,
      detailTab: 'pattern',
      isExpandedPerFileDetails: false,
    });
  },

  setProviderUploadHandler: (handler: ProviderUploadHandler | null) => {
    set({ providerUploadHandler: handler || null });
  },
}));
