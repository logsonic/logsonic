import { useState, useCallback } from 'react';
import type { FilePreview, Pattern, FileParserHookResult } from '../types';
import { extractFields } from '../utils/patternUtils';

// Default pattern to use if no pattern is detected
const DEFAULT_PATTERN: Pattern = {
  name: "Default",
  pattern: "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
  description: "Default pattern for common log formats",
  fields: ["timestamp", "level", "message"],
  custom_patterns: {} // Add empty custom_patterns object
};

export const useFileParser = (): FileParserHookResult => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview>({
    lines: [],
    totalLines: 0,
    fileSize: 0
  });
  const [selectedPattern, setSelectedPattern] = useState<Pattern>(DEFAULT_PATTERN);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;

    setSelectedFile(file);

    // Read the first few lines of the file for preview
    const reader = new FileReader();
    const MAX_PREVIEW_SIZE = 10 * 1024; // 10KB
    const blob = file.slice(0, MAX_PREVIEW_SIZE);
    
    reader.onload = (e) => {
      const content = e.target?.result as string || '';
      const lines = content.split('\n').filter(line => line.trim() !== '');
      const previewLines = lines.slice(0, 20); // Show first 20 lines
      
      // Count total lines (approximate for large files)
      const bytesPerLine = content.length / (lines.length || 1);
      const approxTotalLines = Math.ceil(file.size / bytesPerLine);
      
      setFilePreview({
        lines: previewLines,
        totalLines: approxTotalLines,
        fileSize: file.size
      });
    };
    
    reader.readAsText(blob);
  }, []);

  return {
    selectedFile,
    filePreview,
    handleFileSelect,
    selectedPattern,
    setSelectedPattern
  };
};

export default useFileParser; 