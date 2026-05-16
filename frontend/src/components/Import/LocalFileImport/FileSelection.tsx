import { File as FileIcon, Plus, Trash2, Upload } from 'lucide-react';
import { FC, useCallback, useRef, useState } from 'react';
import { useImportStore } from '../../../stores/useImportStore';
import type { LogSourceProvider } from '../types';
import { useFileSelectionService } from './FileSelectionService';

const ACCEPTED_TYPES = ['.log', '.txt', '.json'];
const ACCEPTED_MIME = ['text/plain', 'application/json'];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

function isAcceptedFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  return ACCEPTED_TYPES.includes(ext) || ACCEPTED_MIME.includes(file.type);
}

export const FileSelection: FC<LogSourceProvider> = ({
  onFileSelect,
  onFilePreview,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { error, files, addFiles, removeFile, setMetadata, setSelectedFileName, setSelectedFileHandle, setFilePreviewBuffer, setSourceMTime } = useImportStore();
  const fileService = useFileSelectionService();
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileErrors, setFileErrors] = useState<string[]>([]);

  const processFiles = useCallback(async (selectedFiles: File[]) => {
    const errors: string[] = [];
    const validFiles: File[] = [];

    // Check for duplicates against existing files
    const existingNames = new Set(files.map(f => f.fileName));

    for (const file of selectedFiles) {
      if (!isAcceptedFile(file)) {
        errors.push(`"${file.name}" is not a supported file type (.log, .txt, .json)`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`"${file.name}" exceeds the 500 MB size limit`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`"${file.name}" is empty`);
        continue;
      }
      if (existingNames.has(file.name)) {
        errors.push(`"${file.name}" is already added`);
        continue;
      }
      existingNames.add(file.name);
      validFiles.push(file);
    }

    setFileErrors(errors);

    if (validFiles.length === 0) return;

    // Add files to the multi-file store
    addFiles(validFiles);

    // For backward compatibility: set the first file as primary
    const primaryFile = files.length === 0 ? validFiles[0] : null;
    if (primaryFile) {
      setMetadata({ _src: `file.${primaryFile.name}` });
      setSelectedFileName(primaryFile.name);
      setSelectedFileHandle(primaryFile);
      // Browser File API exposes lastModified as a unix epoch in ms.
      // Hand it to the backend so the timestamp resolver can anchor
      // year-less / 2-digit-year logs against the file's mtime instead
      // of falling back to wall-clock now.
      if (primaryFile.lastModified) {
        setSourceMTime(new Date(primaryFile.lastModified).toISOString());
      } else {
        setSourceMTime(null);
      }

      await onFileSelect(primaryFile.name);

      // Generate preview for the first file
      await fileService.handleFilePreview(primaryFile, (lines) => {
        if (lines.length > 0) {
          setFilePreviewBuffer({ lines, filename: primaryFile.name });
          onFilePreview(lines, primaryFile.name);
        }
      });
    } else {
      // Files added to existing list, signal readiness
      onFilePreview([], validFiles[0].name);
    }
  }, [files, addFiles, setMetadata, setSelectedFileName, setSelectedFileHandle, setFilePreviewBuffer, fileService, onFileSelect, onFilePreview]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > 0) {
      await processFiles(selectedFiles);
    }
    // Reset input so the same file(s) can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      await processFiles(droppedFiles);
    }
  }, [processFiles]);

  const handleRemoveFile = (fileId: string) => {
    removeFile(fileId);
  };

  const handleAddMoreClick = () => {
    fileInputRef.current?.click();
  };

  const dropZoneBorder = isDragOver
    ? 'var(--ls-accent)'
    : 'var(--ls-border-strong)';
  const dropZoneBg = isDragOver
    ? 'var(--ls-accent-softer)'
    : 'var(--ls-bg-1)';

  return (
    <div className="space-y-3 pt-2">
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--ls-text)',
          letterSpacing: '-0.005em',
        }}
      >
        {files.length === 0 ? 'Add log files' : 'Selected files'}
      </h2>

      {/* Drop zone */}
      <div
        className="cursor-pointer transition-all"
        style={{
          padding: files.length === 0 ? 28 : 14,
          borderRadius: 10,
          border: `1.5px dashed ${dropZoneBorder}`,
          background: dropZoneBg,
          textAlign: 'center',
          boxShadow: isDragOver ? '0 0 0 4px var(--ls-accent-softer)' : 'none',
          transform: isDragOver ? 'scale(1.005)' : 'none',
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".log,.txt,.json,text/plain,application/json"
          multiple
          onChange={handleFileSelect}
        />

        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center" style={{ padding: '8px 0' }}>
            <div
              className="flex items-center justify-center"
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: 'var(--ls-accent-soft)',
                border: '1px solid var(--ls-accent-border)',
                marginBottom: 14,
              }}
            >
              <Upload size={22} style={{ color: 'var(--ls-accent)' }} />
            </div>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--ls-text)',
              }}
            >
              Drop log files here, or click to browse
            </span>
            <span style={{ marginTop: 6, fontSize: 12, color: 'var(--ls-text-2)' }}>
              <span
                style={{
                  fontFamily: 'var(--ls-font-mono)',
                  background: 'var(--ls-bg-2)',
                  border: '1px solid var(--ls-border)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  marginRight: 6,
                }}
              >
                .log
              </span>
              <span
                style={{
                  fontFamily: 'var(--ls-font-mono)',
                  background: 'var(--ls-bg-2)',
                  border: '1px solid var(--ls-border)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  marginRight: 6,
                }}
              >
                .txt
              </span>
              <span
                style={{
                  fontFamily: 'var(--ls-font-mono)',
                  background: 'var(--ls-bg-2)',
                  border: '1px solid var(--ls-border)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  marginRight: 6,
                }}
              >
                .json
              </span>
              <span style={{ color: 'var(--ls-text-3)' }}>· up to 500 MB each</span>
            </span>
            <span style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ls-text-3)' }}>
              LogSonic auto-detects the best Grok pattern for each file.
            </span>
          </div>
        ) : (
          <div
            className="inline-flex items-center"
            style={{
              gap: 6,
              fontSize: 12.5,
              fontWeight: 500,
              color: 'var(--ls-accent)',
            }}
          >
            <Plus size={15} />
            <span>Add more files</span>
          </div>
        )}
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between" style={{ padding: '0 2px' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ls-text-3)',
              }}
            >
              {files.length} file{files.length !== 1 ? 's' : ''} selected
            </span>
            <button
              type="button"
              onClick={handleAddMoreClick}
              className="inline-flex items-center transition-colors"
              style={{
                gap: 4,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--ls-accent)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ls-accent-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ls-accent)')}
            >
              <Plus size={13} />
              Add more
            </button>
          </div>

          <div
            style={{
              borderRadius: 8,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-panel)',
              overflow: 'hidden',
            }}
          >
            {files.map((importFile, index) => (
              <div
                key={importFile.id}
                className="flex items-center justify-between transition-colors group animate-in fade-in slide-in-from-top-1 duration-200"
                style={{
                  padding: '10px 14px',
                  borderBottom:
                    index < files.length - 1
                      ? '1px solid var(--ls-border-subtle)'
                      : 'none',
                  animationDelay: `${index * 40}ms`,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ls-bg-1)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div className="flex items-center min-w-0 flex-1" style={{ gap: 10 }}>
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
                    <FileIcon size={13} style={{ color: 'var(--ls-accent)' }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'var(--ls-text)',
                      }}
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
                      {formatFileSize(importFile.fileSize)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveFile(importFile.id);
                  }}
                  className="ls-danger-btn flex items-center justify-center transition-all"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    color: 'var(--ls-text-3)',
                    background: 'transparent',
                    border: '1px solid transparent',
                    cursor: 'pointer',
                  }}
                  title="Remove file"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File validation errors */}
      {fileErrors.length > 0 && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 6,
            background: 'var(--ls-warn-soft)',
            border: '1px solid color-mix(in srgb, var(--ls-warn) 25%, transparent)',
          }}
        >
          {fileErrors.map((err, i) => (
            <p
              key={i}
              className="flex items-start"
              style={{ fontSize: 12, color: 'var(--ls-warn)', lineHeight: 1.5 }}
            >
              <span style={{ marginRight: 6, flexShrink: 0 }}>&#x26A0;</span>
              {err}
            </p>
          ))}
        </div>
      )}

      {/* Global error */}
      {error && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 6,
            background: 'var(--ls-err-soft)',
            border: '1px solid color-mix(in srgb, var(--ls-err) 25%, transparent)',
            textAlign: 'center',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--ls-err)' }}>{error}</span>
        </div>
      )}
    </div>
  );
};

export default FileSelection;
