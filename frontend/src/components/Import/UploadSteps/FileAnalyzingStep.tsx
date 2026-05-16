import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';
import { Check, ChevronDown, ChevronRight, AlertTriangle, File, Loader2, RefreshCw, Search } from 'lucide-react';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { parseLogs, suggestPatterns } from '../../../lib/api-client';
import { GrokPatternRequest } from '@/lib/api-types';
import type { DetectionResult, ImportFile, Pattern } from '../types';
import { extractFields } from '../utils/patternUtils';
import { PatternTestResults } from './PatternTestResults';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useFileSelectionService } from '../LocalFileImport/FileSelectionService';

interface FileAnalyzingStepProps {
  onDetectionComplete: (result: DetectionResult) => void;
}

// Per-file pattern card component
const FilePatternCard: FC<{
  importFile: ImportFile;
  availablePatterns: GrokPatternRequest[];
  onPatternChange: (fileId: string, pattern: Pattern) => void;
  onTestPattern: (fileId: string, pattern: Pattern) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}> = ({ importFile, availablePatterns, onPatternChange, onTestPattern, isExpanded, onToggleExpand }) => {
  const [showPatternDropdown, setShowPatternDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Local state for editing the custom grok pattern string (only used when Custom Pattern is selected)
  const [customPatternText, setCustomPatternText] = useState(
    importFile.selectedPattern?.pattern ?? DEFAULT_PATTERN.pattern
  );

  // Sync custom pattern text when the file's selected pattern changes externally
  useEffect(() => {
    setCustomPatternText(importFile.selectedPattern?.pattern ?? DEFAULT_PATTERN.pattern);
  }, [importFile.selectedPattern?.name]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowPatternDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const statusConfig = {
    pending:   { bg: 'var(--ls-bg-2)',     border: 'var(--ls-border)',                                                fg: 'var(--ls-text-3)', label: 'Queued',                  icon: null },
    detecting: { bg: 'var(--ls-info-soft)', border: 'color-mix(in srgb, var(--ls-info) 25%, transparent)',            fg: 'var(--ls-info)',   label: 'Detecting…',              icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    detected:  { bg: 'var(--ls-ok-soft)',   border: 'color-mix(in srgb, var(--ls-ok) 25%, transparent)',              fg: 'var(--ls-ok)',     label: 'Pattern found',           icon: <Check className="h-3 w-3" /> },
    failed:    { bg: 'var(--ls-warn-soft)', border: 'color-mix(in srgb, var(--ls-warn) 25%, transparent)',            fg: 'var(--ls-warn)',   label: 'Manual selection needed', icon: <AlertTriangle className="h-3 w-3" /> },
  } as const;

  const status = statusConfig[importFile.detectionStatus];
  const selectedPattern = importFile.selectedPattern;
  // Show the custom pattern editor when the selected pattern is "Custom Pattern",
  // regardless of the isCustomPattern flag (guards against sync issues)
  const isShowingCustomEditor = selectedPattern?.name === DEFAULT_PATTERN.name;
  const successCount = importFile.parsedLogs.filter(l => !l.error).length;
  const previewCount = importFile.previewLines.length;
  const matchRate = previewCount > 0 ? Math.round((successCount / Math.min(previewCount, 20)) * 100) : 0;

  const handlePatternSelect = (patternName: string) => {
    const pattern = availablePatterns.find(p => p.name === patternName);
    if (pattern) {
      onPatternChange(importFile.id, {
        ...pattern,
        custom_patterns: pattern.custom_patterns || {},
        fields: extractFields(pattern.pattern),
      });
      setShowPatternDropdown(false);
      setSearchQuery('');
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className="transition-all duration-200"
      style={{
        borderRadius: 8,
        border: `1px solid ${isExpanded ? 'var(--ls-accent-border)' : 'var(--ls-border)'}`,
        background: 'var(--ls-panel)',
        boxShadow: isExpanded ? '0 0 0 3px var(--ls-accent-softer)' : 'var(--ls-shadow-sm)',
        overflow: 'hidden',
      }}
    >
      {/* Card header - always visible */}
      <div
        className="flex items-center cursor-pointer select-none transition-colors"
        style={{
          gap: 10,
          padding: '10px 14px',
          background: isExpanded ? 'var(--ls-bg-1)' : 'transparent',
        }}
        onClick={onToggleExpand}
        onMouseEnter={(e) => {
          if (!isExpanded) e.currentTarget.style.background = 'var(--ls-bg-1)';
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) e.currentTarget.style.background = 'transparent';
        }}
      >
        {/* Expand chevron */}
        <div className="flex-shrink-0" style={{ color: 'var(--ls-text-3)' }}>
          {isExpanded
            ? <ChevronDown size={14} />
            : <ChevronRight size={14} />
          }
        </div>

        {/* File icon */}
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: 'var(--ls-accent-soft)',
            border: '1px solid var(--ls-accent-border)',
          }}
        >
          <File size={13} style={{ color: 'var(--ls-accent)' }} />
        </div>

        {/* File name + size */}
        <div className="min-w-0 flex-1">
          <p
            className="truncate"
            style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}
          >
            {importFile.fileName}
          </p>
          <p
            style={{
              fontSize: 11,
              color: 'var(--ls-text-3)',
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            {formatSize(importFile.fileSize)}
            {importFile.approxLines > 0 && ` \u00B7 ~${importFile.approxLines.toLocaleString()} lines`}
          </p>
        </div>

        {/* Detection status pill */}
        <span
          className="inline-flex items-center flex-shrink-0"
          style={{
            gap: 4,
            height: 20,
            padding: '0 8px',
            borderRadius: 10,
            background: status.bg,
            color: status.fg,
            border: `1px solid ${status.border}`,
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          {status.icon}
          {status.label}
        </span>

        {/* Pattern name pill */}
        {selectedPattern && importFile.detectionStatus !== 'detecting' && (
          <span
            className="inline-flex items-center truncate flex-shrink-0"
            style={{
              maxWidth: 200,
              height: 20,
              padding: '0 8px',
              borderRadius: 4,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-bg-1)',
              color: 'var(--ls-text-2)',
              fontSize: 11,
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            {selectedPattern.name}
          </span>
        )}

        {/* Match rate indicator */}
        {importFile.detectionStatus === 'detected' && matchRate > 0 && (
          <div
            className="flex items-center flex-shrink-0"
            style={{ gap: 4 }}
            title={`${matchRate}% of preview lines matched`}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background:
                  matchRate >= 80
                    ? 'var(--ls-ok)'
                    : matchRate >= 50
                      ? 'var(--ls-warn)'
                      : 'var(--ls-err)',
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: 'var(--ls-text-3)',
                fontFamily: 'var(--ls-font-mono)',
              }}
            >
              {matchRate}%
            </span>
          </div>
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div
          className="space-y-4 animate-in fade-in slide-in-from-top-1 duration-200"
          style={{
            padding: '14px 16px',
            borderTop: '1px solid var(--ls-border)',
            background: 'var(--ls-bg-1)',
          }}
        >
          {/* Pattern selector */}
          <div className="space-y-2">
            <label
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ls-text-3)',
                display: 'block',
              }}
            >
              Pattern
            </label>
            <div className="flex" style={{ gap: 8 }} ref={dropdownRef}>
              <div className="relative flex-1">
                <div
                  className="flex items-center justify-between cursor-pointer transition-colors"
                  style={{
                    height: 32,
                    padding: '0 10px',
                    borderRadius: 6,
                    border: '1px solid var(--ls-border-strong)',
                    background: 'var(--ls-panel)',
                    fontSize: 12.5,
                    color: 'var(--ls-text)',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPatternDropdown(!showPatternDropdown);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--ls-accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--ls-border-strong)')}
                >
                  {selectedPattern ? (
                    <span className="truncate">
                      <b>{selectedPattern.name}</b>
                      {selectedPattern.description && (
                        <span style={{ color: 'var(--ls-text-3)' }}>: {selectedPattern.description}</span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--ls-text-3)' }}>Select a pattern…</span>
                  )}
                  <ChevronDown size={12} style={{ marginLeft: 8, opacity: 0.6, flexShrink: 0 }} />
                </div>

                {showPatternDropdown && (
                  <div className="absolute z-50 w-full bg-white border rounded-lg shadow-lg mt-1">
                    <Command className="rounded-lg">
                      <CommandInput
                        placeholder="Search patterns..."
                        className="h-9 border-none focus-visible:ring-0 text-sm"
                        value={searchQuery}
                        onValueChange={setSearchQuery}
                        autoFocus
                      />
                      <CommandList className="p-1">
                        <CommandEmpty>No pattern found.</CommandEmpty>
                        <CommandGroup className="max-h-[200px] overflow-auto">
                          {availablePatterns
                            .filter(p =>
                              p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                              (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()))
                            )
                            .map((pattern) => (
                              <CommandItem
                                key={pattern.name}
                                value={pattern.name}
                                onSelect={handlePatternSelect}
                                className="flex items-center px-2 py-1.5 text-sm cursor-pointer"
                              >
                                <Check className={cn(
                                  "mr-2 h-3 w-3",
                                  selectedPattern?.name === pattern.name ? "opacity-100" : "opacity-0"
                                )} />
                                <span><b>{pattern.name}</b>{pattern.description ? `: ${pattern.description}` : ''}</span>
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={!selectedPattern || importFile.detectionStatus === 'detecting'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!selectedPattern) return;
                  if (isShowingCustomEditor) {
                    const patternToTest: Pattern = {
                      ...selectedPattern,
                      pattern: customPatternText,
                      fields: extractFields(customPatternText),
                    };
                    onTestPattern(importFile.id, patternToTest);
                  } else {
                    onTestPattern(importFile.id, selectedPattern);
                  }
                }}
                className="inline-flex items-center justify-center transition-colors"
                style={{
                  gap: 5,
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 6,
                  border: '1px solid var(--ls-border-strong)',
                  background: 'var(--ls-panel)',
                  color: 'var(--ls-text)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  opacity: !selectedPattern || importFile.detectionStatus === 'detecting' ? 0.5 : 1,
                }}
              >
                <Search size={12} />
                Test
              </button>
            </div>

            {/* Custom pattern editor — shown instead of the read-only preview */}
            {isShowingCustomEditor ? (
              <div className="space-y-1">
                <label
                  style={{
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: 'var(--ls-text-3)',
                    display: 'block',
                  }}
                >
                  Grok pattern string
                </label>
                <Textarea
                  value={customPatternText}
                  onChange={(e) => setCustomPatternText(e.target.value)}
                  onBlur={() => {
                    const committed: Pattern = {
                      ...DEFAULT_PATTERN,
                      pattern: customPatternText,
                      fields: extractFields(customPatternText),
                    };
                    onPatternChange(importFile.id, committed);
                  }}
                  placeholder="%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}"
                  className="resize-none"
                  style={{
                    fontFamily: 'var(--ls-font-mono)',
                    fontSize: 11.5,
                    minHeight: 60,
                    background: 'var(--ls-panel)',
                    border: '1px solid var(--ls-border-strong)',
                    color: 'var(--ls-text)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <p style={{ fontSize: 11, color: 'var(--ls-text-3)' }}>
                  Type a Grok pattern, then click <strong>Test</strong> to preview results.
                </p>
              </div>
            ) : (
              /* Read-only pattern preview for named patterns */
              selectedPattern && (
                <div
                  className="overflow-x-auto"
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--ls-border)',
                    background: 'var(--ls-panel)',
                    fontFamily: 'var(--ls-font-mono)',
                    fontSize: 11.5,
                    color: 'var(--ls-text-2)',
                  }}
                >
                  {selectedPattern.pattern}
                </div>
              )
            )}

            {/* Extracted fields */}
            {selectedPattern && selectedPattern.fields && selectedPattern.fields.length > 0 && (
              <div className="flex flex-wrap" style={{ gap: 4 }}>
                {selectedPattern.fields.map(field => (
                  <span
                    key={field}
                    className="inline-flex items-center"
                    style={{
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: 'var(--ls-accent-softer)',
                      border: '1px solid var(--ls-accent-border)',
                      color: 'var(--ls-accent-text)',
                      fontFamily: 'var(--ls-font-mono)',
                      fontSize: 10.5,
                    }}
                  >
                    {field}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Detection error */}
          {importFile.detectionError && (
            <div
              className="flex items-start"
              style={{
                gap: 8,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--ls-warn-soft)',
                border: '1px solid color-mix(in srgb, var(--ls-warn) 25%, transparent)',
              }}
            >
              <AlertTriangle size={14} style={{ color: 'var(--ls-warn)', flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--ls-warn)' }}>
                {importFile.detectionError}
              </span>
            </div>
          )}

          {/* Full pattern test results – same rich view as the original wizard */}
          {importFile.previewLines.length > 0 && (
            <PatternTestResults
              pattern={importFile.selectedPattern?.pattern || ''}
              customPatterns={importFile.selectedPattern?.custom_patterns || {}}
              logs={importFile.previewLines.slice(0, 20)}
              parsedLogsOverride={importFile.parsedLogs}
              isLoadingOverride={importFile.detectionStatus === 'detecting'}
              errorOverride={importFile.detectionError ?? null}
            />
          )}
        </div>
      )}
    </div>
  );
};


export const FileAnalyzingStep: FC<FileAnalyzingStepProps> = ({
  onDetectionComplete,
}) => {
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null);
  const [allDetecting, setAllDetecting] = useState(false);
  const detectionRanRef = useRef(false);

  const {
    files,
    updateFile,
    availablePatterns,
    importSource,
    setReadyToImportLogs,
    setTimestampInference,
    setSourceMTime,
    setFileTimestampInference,
    setActiveFileId,
  } = useImportStore();

  const fileService = useFileSelectionService();

  const isMultiFile = importSource === 'file' && files.length > 0;

  // --- Multi-file pattern detection ---

  const detectPatternForFile = useCallback(async (file: ImportFile): Promise<Partial<ImportFile>> => {
    try {
      // Read preview if not already done
      let previewLines = file.previewLines;
      if (previewLines.length === 0) {
        previewLines = await new Promise<string[]>((resolve) => {
          fileService.handleFilePreview(file.file, (lines) => {
            resolve(lines);
          });
        });
      }

      const approxLines = previewLines.length;

      // Auto-suggest patterns
      const suggestResponse = await suggestPatterns({ logs: previewLines });

      if (suggestResponse.results && suggestResponse.results.length > 0) {
        const bestMatch = suggestResponse.results[0];

        // Test the best match. Pass source_mtime so the resolver
        // anchors year-less / 2-digit-year timestamps against the
        // file rather than falling back to wall-clock now.
        const parseResponse = await parseLogs({
          logs: previewLines.slice(0, 20),
          grok_pattern: bestMatch.pattern,
          custom_patterns: bestMatch.custom_patterns || {},
          session_options: {
            source_mtime: file.file.lastModified ? new Date(file.file.lastModified).toISOString() : undefined,
          },
        });

        if (parseResponse.logs && parseResponse.logs.length > 0) {
          // Per-file: stash the resolver's verdict on the file record
          // so the panel can show this file's own inference when
          // active. Also mirror to global state for the legacy
          // single-file consumers that still read it.
          if (parseResponse.timestamp_inference) {
            setFileTimestampInference(file.id, parseResponse.timestamp_inference);
            setTimestampInference(parseResponse.timestamp_inference);
          }
          if (file.file.lastModified) {
            setSourceMTime(new Date(file.file.lastModified).toISOString());
          }
          // Match a server pattern if possible
          const matchingPattern = availablePatterns.find(p => p.pattern === bestMatch.pattern);
          const detectedPattern: Pattern = matchingPattern
            ? { ...matchingPattern, fields: extractFields(matchingPattern.pattern), custom_patterns: matchingPattern.custom_patterns || {} }
            : {
                name: bestMatch.pattern_name || 'Auto-detected',
                pattern: bestMatch.pattern,
                description: bestMatch.pattern_description || 'Automatically detected pattern',
                custom_patterns: bestMatch.custom_patterns,
                fields: extractFields(bestMatch.pattern),
              };

          return {
            previewLines,
            approxLines,
            detectedPattern,
            selectedPattern: detectedPattern,
            parsedLogs: parseResponse.logs,
            detectionStatus: 'detected',
            detectionError: null,
          };
        }
      }

      // No pattern matched
      return {
        previewLines,
        approxLines,
        selectedPattern: DEFAULT_PATTERN,
        isCustomPattern: true,
        detectionStatus: 'failed',
        detectionError: 'No pattern auto-detected. Please select a pattern manually.',
      };
    } catch (err) {
      return {
        detectionStatus: 'failed',
        detectionError: err instanceof Error ? err.message : 'Detection failed',
        selectedPattern: DEFAULT_PATTERN,
        isCustomPattern: true,
      };
    }
  }, [availablePatterns, fileService]);

  const runAllDetections = useCallback(async () => {
    if (files.length === 0) return;

    setAllDetecting(true);

    // Mark all as detecting
    for (const file of files) {
      updateFile(file.id, { detectionStatus: 'detecting' });
    }

    // Run detections sequentially to avoid overwhelming the server
    for (const file of files) {
      const updates = await detectPatternForFile(file);
      updateFile(file.id, updates);
    }

    setAllDetecting(false);
    setReadyToImportLogs(true);

    // Auto-expand the first file that needs attention. Also set
    // activeFileId so the TimestampPanel can read that file's
    // per-file inference. Priority: timestamp issue > pattern
    // detection failure > first file.
    const currentFiles = useImportStore.getState().files;
    const tsAttention = currentFiles.find(f =>
      f.timestampInference && (f.timestampInference.status === 'ambiguous' || f.timestampInference.status === 'missing')
    );
    const needsAttention = tsAttention || currentFiles.find(f => f.detectionStatus === 'failed');
    if (needsAttention) {
      setExpandedFileId(needsAttention.id);
      setActiveFileId(needsAttention.id);
    } else if (currentFiles.length === 1) {
      setExpandedFileId(currentFiles[0].id);
      setActiveFileId(currentFiles[0].id);
    } else if (currentFiles.length > 0) {
      // Multi-file with everything green — still need an active file
      // for the panel to render against.
      setActiveFileId(currentFiles[0].id);
    }

    // Signal detection complete
    const allDetected = currentFiles.every(f => f.detectionStatus === 'detected');
    onDetectionComplete({
      isOngoing: false,
      suggestedPattern: currentFiles[0]?.selectedPattern || undefined,
      error: allDetected ? undefined : 'Some files need manual pattern selection',
    });
  }, [files, detectPatternForFile, updateFile, setReadyToImportLogs, onDetectionComplete]);

  // Run detection on mount for multi-file mode
  useEffect(() => {
    if (isMultiFile && !detectionRanRef.current) {
      detectionRanRef.current = true;
      runAllDetections();
    }
  }, [isMultiFile]);

  // --- Multi-file handlers ---

  const handleFilePatternChange = useCallback(async (fileId: string, pattern: Pattern) => {
    const file = files.find(f => f.id === fileId);
    if (!file) return;

    updateFile(fileId, { detectionStatus: 'detecting' });

    try {
      const previewLines = file.previewLines.slice(0, 20);
      const parseResponse = await parseLogs({
        logs: previewLines,
        grok_pattern: pattern.pattern,
        custom_patterns: pattern.custom_patterns || {},
      });

      updateFile(fileId, {
        selectedPattern: pattern,
        isCustomPattern: pattern.name === DEFAULT_PATTERN.name,
        parsedLogs: parseResponse.logs || [],
        detectionStatus: 'detected',
        detectionError: null,
      });
    } catch (err) {
      updateFile(fileId, {
        selectedPattern: pattern,
        isCustomPattern: pattern.name === DEFAULT_PATTERN.name,
        detectionStatus: 'failed',
        detectionError: err instanceof Error ? err.message : 'Failed to test pattern',
      });
    }
  }, [files, updateFile]);

  const handleFileTestPattern = useCallback(async (fileId: string, pattern: Pattern) => {
    await handleFilePatternChange(fileId, pattern);
  }, [handleFilePatternChange]);

  // --- Render ---

  // Multi-file mode
  if (isMultiFile) {
    const detectedCount = files.filter(f => f.detectionStatus === 'detected').length;
    const failedCount = files.filter(f => f.detectionStatus === 'failed').length;
    const detectingCount = files.filter(f => f.detectionStatus === 'detecting' || f.detectionStatus === 'pending').length;

    return (
      <div className="space-y-4">
        {/* Summary header */}
        <div className="flex items-center justify-between">
          <div>
            <h3
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ls-text)',
                letterSpacing: '-0.005em',
              }}
            >
              Pattern configuration
            </h3>
            <p style={{ fontSize: 12, color: 'var(--ls-text-3)', marginTop: 2 }}>
              {allDetecting ? (
                'Auto-detecting patterns for each file\u2026'
              ) : (
                <>
                  {detectedCount > 0 && (
                    <span style={{ color: 'var(--ls-ok)' }}>
                      {detectedCount} matched
                    </span>
                  )}
                  {detectedCount > 0 && failedCount > 0 && (
                    <span style={{ color: 'var(--ls-text-4)' }}> \u00B7 </span>
                  )}
                  {failedCount > 0 && (
                    <span style={{ color: 'var(--ls-warn)' }}>
                      {failedCount} need attention
                    </span>
                  )}
                  {detectingCount > 0 && (
                    <span style={{ color: 'var(--ls-info)' }}>
                      {' '}
                      \u00B7 {detectingCount} detecting
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
          {!allDetecting && (
            <button
              type="button"
              onClick={() => {
                detectionRanRef.current = false;
                runAllDetections();
              }}
              className="inline-flex items-center transition-colors"
              style={{
                gap: 5,
                height: 28,
                padding: '0 10px',
                borderRadius: 6,
                border: '1px solid var(--ls-border)',
                background: 'var(--ls-panel)',
                color: 'var(--ls-text-2)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--ls-bg-2)';
                e.currentTarget.style.color = 'var(--ls-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--ls-panel)';
                e.currentTarget.style.color = 'var(--ls-text-2)';
              }}
            >
              <RefreshCw size={12} />
              Re-detect all
            </button>
          )}
        </div>

        {/* Progress bar during detection */}
        {allDetecting && (
          <div className="space-y-1">
            <div
              style={{
                height: 6,
                borderRadius: 99,
                overflow: 'hidden',
                background: 'var(--ls-bg-2)',
                border: '1px solid var(--ls-border)',
              }}
            >
              <div
                className="transition-all duration-500"
                style={{
                  height: '100%',
                  background: 'var(--ls-accent)',
                  width: `${((detectedCount + failedCount) / files.length) * 100}%`,
                }}
              />
            </div>
            <p
              style={{
                fontSize: 11,
                color: 'var(--ls-text-3)',
                textAlign: 'right',
                fontFamily: 'var(--ls-font-mono)',
              }}
            >
              {detectedCount + failedCount} / {files.length} files analyzed
            </p>
          </div>
        )}

        {/* File cards */}
        <div className="space-y-2">
          {files.map((file) => (
            <FilePatternCard
              key={file.id}
              importFile={file}
              availablePatterns={availablePatterns}
              onPatternChange={handleFilePatternChange}
              onTestPattern={handleFileTestPattern}
              isExpanded={expandedFileId === file.id}
              onToggleExpand={() => setExpandedFileId(expandedFileId === file.id ? null : file.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  return null;
};

export default FileAnalyzingStep;
