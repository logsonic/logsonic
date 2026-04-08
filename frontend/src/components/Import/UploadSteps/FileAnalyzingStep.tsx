import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';
import { Check, ChevronDown, ChevronRight, AlertTriangle, Cloud, File, Loader2, RefreshCw, Search } from 'lucide-react';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { parseLogs, suggestPatterns } from '../../../lib/api-client';
import { GrokPatternRequest } from '@/lib/api-types';
import type { DetectionResult, ImportFile, Pattern } from '../types';
import { extractFields } from '../utils/patternUtils';
import { CustomPatternSelector } from './CustomPatternSelector';
import { LogPatternSelection } from './LogPatternSelection';
import { PatternTestResults } from './PatternTestResults';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
    pending: { color: 'bg-gray-100 text-gray-600', label: 'Queued', icon: null },
    detecting: { color: 'bg-blue-100 text-blue-700', label: 'Detecting...', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    detected: { color: 'bg-green-100 text-green-700', label: 'Pattern found', icon: <Check className="h-3 w-3" /> },
    failed: { color: 'bg-amber-100 text-amber-700', label: 'Manual selection needed', icon: <AlertTriangle className="h-3 w-3" /> },
  };

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
    <div className={`border rounded-lg overflow-hidden transition-all duration-200 ${
      isExpanded ? 'shadow-md ring-1 ring-blue-200' : 'shadow-sm hover:shadow-md'
    }`}>
      {/* Card header - always visible */}
      <div
        className="flex items-center gap-3 px-4 py-3 bg-white cursor-pointer select-none hover:bg-gray-50/50 transition-colors"
        onClick={onToggleExpand}
      >
        {/* Expand chevron */}
        <div className="flex-shrink-0 text-gray-400">
          {isExpanded
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />
          }
        </div>

        {/* File icon */}
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
          <File className="h-4 w-4 text-blue-600" />
        </div>

        {/* File name + size */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-800 truncate">{importFile.fileName}</p>
          <p className="text-xs text-gray-500">
            {formatSize(importFile.fileSize)}
            {importFile.approxLines > 0 && ` \u00B7 ~${importFile.approxLines.toLocaleString()} lines`}
          </p>
        </div>

        {/* Detection status badge */}
        <Badge variant="secondary" className={`${status.color} flex items-center gap-1 text-xs flex-shrink-0`}>
          {status.icon}
          {status.label}
        </Badge>

        {/* Pattern name badge */}
        {selectedPattern && importFile.detectionStatus !== 'detecting' && (
          <Badge variant="outline" className="text-xs flex-shrink-0 max-w-[200px] truncate">
            {selectedPattern.name}
          </Badge>
        )}

        {/* Match rate indicator */}
        {importFile.detectionStatus === 'detected' && matchRate > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0" title={`${matchRate}% of preview lines matched`}>
            <div className={`w-2 h-2 rounded-full ${
              matchRate >= 80 ? 'bg-green-500' : matchRate >= 50 ? 'bg-amber-500' : 'bg-red-500'
            }`} />
            <span className="text-xs text-gray-500">{matchRate}%</span>
          </div>
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t bg-gray-50/50 px-4 py-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Pattern selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Pattern</label>
            <div className="flex gap-2" ref={dropdownRef}>
              <div className="relative flex-1">
                <div
                  className="flex items-center border rounded-md h-9 px-3 justify-between bg-white cursor-pointer text-sm hover:border-gray-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPatternDropdown(!showPatternDropdown);
                  }}
                >
                  {selectedPattern ? (
                    <span className="truncate">
                      <b>{selectedPattern.name}</b>
                      {selectedPattern.description && `: ${selectedPattern.description}`}
                    </span>
                  ) : (
                    <span className="text-gray-400">Select a pattern...</span>
                  )}
                  <ChevronDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
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

              <Button
                size="sm"
                variant="outline"
                className="h-9 text-sm"
                disabled={!selectedPattern || importFile.detectionStatus === 'detecting'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!selectedPattern) return;
                  if (isShowingCustomEditor) {
                    // Use the locally-edited pattern string
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
              >
                <Search className="h-3 w-3 mr-1.5" />
                Test
              </Button>
            </div>

            {/* Custom pattern editor — shown instead of the read-only preview */}
            {isShowingCustomEditor ? (
              <div className="space-y-1">
                <label className="text-xs text-gray-500">Grok pattern string</label>
                <Textarea
                  value={customPatternText}
                  onChange={(e) => setCustomPatternText(e.target.value)}
                  onBlur={() => {
                    // Commit the edited pattern to the store on blur
                    const committed: Pattern = {
                      ...DEFAULT_PATTERN,
                      pattern: customPatternText,
                      fields: extractFields(customPatternText),
                    };
                    onPatternChange(importFile.id, committed);
                  }}
                  placeholder="%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}"
                  className="font-mono text-xs min-h-[56px] resize-none"
                  onClick={(e) => e.stopPropagation()}
                />
                <p className="text-xs text-gray-400">
                  Type a Grok pattern, then click <strong>Test</strong> to preview results.
                </p>
              </div>
            ) : (
              /* Read-only pattern preview for named patterns */
              selectedPattern && (
                <div className="p-2 bg-white rounded border text-xs font-mono text-gray-600 overflow-x-auto">
                  {selectedPattern.pattern}
                </div>
              )
            )}

            {/* Extracted fields */}
            {selectedPattern && selectedPattern.fields && selectedPattern.fields.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedPattern.fields.map(field => (
                  <Badge key={field} variant="secondary" className="text-xs bg-indigo-50 text-indigo-700">
                    {field}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Detection error */}
          {importFile.detectionError && (
            <div className="flex items-start gap-2 p-2 bg-amber-50 rounded-md text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{importFile.detectionError}</span>
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
    sessionOptionsFileName,
    setReadyToImportLogs,
    // Legacy single-file state for CloudWatch
    filePreviewBuffer,
    selectedPattern,
    setSelectedPattern,
    isCreateNewPatternSelected,
    createNewPattern,
    setCreateNewPattern,
    handlePatternOperation,
    setParsedLogs,
    setError: setStoreError,
  } = useImportStore();

  const fileService = useFileSelectionService();

  const isMultiFile = importSource === 'file' && files.length > 0;
  const isCloudWatch = importSource === 'cloudwatch';

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

        // Test the best match
        const parseResponse = await parseLogs({
          logs: previewLines.slice(0, 20),
          grok_pattern: bestMatch.pattern,
          custom_patterns: bestMatch.custom_patterns || {},
        });

        if (parseResponse.logs && parseResponse.logs.length > 0) {
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

    // Auto-expand the first file that needs attention
    const currentFiles = useImportStore.getState().files;
    const needsAttention = currentFiles.find(f => f.detectionStatus === 'failed');
    if (needsAttention) {
      setExpandedFileId(needsAttention.id);
    } else if (currentFiles.length === 1) {
      setExpandedFileId(currentFiles[0].id);
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

  // --- Legacy single-file CloudWatch flow ---
  const [isAnalyzing, setIsAnalyzing] = useState(true);

  useEffect(() => {
    if (!isCloudWatch || !filePreviewBuffer) return;

    const analyzeFile = async () => {
      try {
        setIsAnalyzing(true);
        setStoreError(null);

        const suggestResponse = await suggestPatterns({ logs: filePreviewBuffer.lines });
        setReadyToImportLogs(true);

        if (suggestResponse.results && suggestResponse.results.length > 0) {
          const bestMatch = suggestResponse.results[0];
          const parseResponse = await parseLogs({
            logs: filePreviewBuffer.lines,
            grok_pattern: bestMatch.pattern,
            custom_patterns: bestMatch.custom_patterns || {},
          });

          if (parseResponse.logs && parseResponse.logs.length > 0) {
            const matchingServerPattern = availablePatterns.find(p => p.pattern === bestMatch.pattern);
            const suggestedPattern: Pattern = matchingServerPattern || {
              name: bestMatch.pattern_name || 'Auto-detected',
              pattern: bestMatch.pattern,
              description: bestMatch.pattern_description || 'Automatically detected pattern',
              custom_patterns: bestMatch.custom_patterns,
              fields: extractFields(bestMatch.pattern),
            };

            setSelectedPattern(suggestedPattern);
            setParsedLogs(parseResponse.logs);
            onDetectionComplete({ isOngoing: false, suggestedPattern, parsedLogs: parseResponse.logs });
          } else {
            setCreateNewPattern(createNewPattern);
            handleLegacyPatternChange(selectedPattern);
            onDetectionComplete({ isOngoing: false, error: 'Auto-detected pattern failed to parse logs' });
          }
        } else {
          setCreateNewPattern(DEFAULT_PATTERN);
          handleLegacyPatternChange(DEFAULT_PATTERN);
          onDetectionComplete({ isOngoing: false, error: 'No patterns could be automatically detected' });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to analyze log file';
        setStoreError(errorMessage);
        setCreateNewPattern(DEFAULT_PATTERN);
        handleLegacyPatternChange(DEFAULT_PATTERN);
        onDetectionComplete({ isOngoing: false, error: errorMessage });
      } finally {
        setIsAnalyzing(false);
      }
    };

    analyzeFile();
  }, [isCloudWatch]);

  const handleLegacyPatternChange = (pattern: Pattern) => {
    setIsAnalyzing(true);
    handlePatternOperation(
      pattern, true,
      (logs) => {
        setParsedLogs(logs);
        onDetectionComplete({ isOngoing: false, suggestedPattern: pattern, parsedLogs: logs });
        setIsAnalyzing(false);
      },
      (errorMsg) => {
        setStoreError(errorMsg);
        setIsAnalyzing(false);
      }
    );
  };

  const handleLegacyPatternTest = (pattern: Pattern) => {
    setIsAnalyzing(true);
    handlePatternOperation(
      pattern, true,
      (logs) => {
        setParsedLogs(logs);
        setIsAnalyzing(false);
      },
      (errorMsg) => {
        setStoreError(errorMsg);
        setIsAnalyzing(false);
      }
    );
  };

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
            <h3 className="text-base font-medium text-gray-800">Pattern Configuration</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {allDetecting ? (
                'Auto-detecting patterns for each file...'
              ) : (
                <>
                  {detectedCount > 0 && <span className="text-green-600">{detectedCount} matched</span>}
                  {detectedCount > 0 && failedCount > 0 && <span> \u00B7 </span>}
                  {failedCount > 0 && <span className="text-amber-600">{failedCount} need attention</span>}
                  {detectingCount > 0 && <span className="text-blue-600"> \u00B7 {detectingCount} detecting</span>}
                </>
              )}
            </p>
          </div>
          {!allDetecting && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                detectionRanRef.current = false;
                runAllDetections();
              }}
              className="text-sm"
            >
              <RefreshCw className="h-3 w-3 mr-1.5" />
              Re-detect all
            </Button>
          )}
        </div>

        {/* Progress bar during detection */}
        {allDetecting && (
          <div className="space-y-1">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${((detectedCount + failedCount) / files.length) * 100}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 text-right">
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

  // CloudWatch / legacy single-file mode
  const logSourceInfo = isCloudWatch
    ? { icon: <Cloud className="h-5 w-5 text-blue-500 mr-2" />, text: `Analyzing CloudWatch logs: ${sessionOptionsFileName || 'Unknown'}` }
    : { icon: <File className="h-5 w-5 text-blue-500 mr-2" />, text: `Analyzing file: ${filePreviewBuffer?.filename || 'Unknown'}` };

  return (
    <div className="space-y-6">
      <div className="flex items-center p-3 bg-blue-50 text-blue-700 rounded-md">
        {logSourceInfo.icon}
        <span className="text-sm font-medium">{logSourceInfo.text}</span>
      </div>

      {isAnalyzing ? (
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-gray-600">Analyzing log format...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {isCreateNewPatternSelected && (
            <div className="flex items-center gap-2 p-3 bg-yellow-50 text-yellow-700 rounded-md border border-yellow-200">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="font-medium">Detected: Custom Pattern</p>
                <p className="text-sm">No standard pattern matched your logs. Please define a custom pattern below.</p>
              </div>
            </div>
          )}

          <LogPatternSelection
            initialPattern={selectedPattern}
            onPatternChange={handleLegacyPatternChange}
            previewLines={filePreviewBuffer?.lines || []}
          />

          {isCreateNewPatternSelected && (
            <CustomPatternSelector
              previewLines={filePreviewBuffer?.lines || []}
              onPatternTest={handleLegacyPatternTest}
            />
          )}

          <div className="mt-6">
            <PatternTestResults
              pattern={selectedPattern?.pattern || ''}
              customPatterns={selectedPattern?.custom_patterns || {}}
              logs={filePreviewBuffer?.lines || []}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default FileAnalyzingStep;
