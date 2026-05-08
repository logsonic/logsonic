import { useCloudWatchStore } from '@/components/Import/CloudWatchImport/stores/useCloudWatchStore';
import { cn } from '@/lib/utils';
import { useImportStore } from '@/stores/useImportStore';
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { Checkbox } from '@/components/ui/checkbox';
import { CheckCircle, Cloud, Code, FileText, Loader2, XCircle } from 'lucide-react';
import { FC, useEffect, useState } from 'react';
import type { ImportFile } from '../types';

// Determinate progress bar — uses accent token, matches the rest of the app
const GreenProgress: FC<{ value: number; className?: string }> = ({
  value,
  className,
}) => (
  <ProgressPrimitive.Root
    className={cn('relative w-full overflow-hidden', className)}
    style={{
      height: 6,
      borderRadius: 99,
      background: 'var(--ls-bg-2)',
      border: '1px solid var(--ls-border)',
    }}
  >
    <ProgressPrimitive.Indicator
      className="h-full flex-1 transition-all"
      style={{
        background: 'var(--ls-accent)',
        transform: `translateX(-${100 - (value || 0)}%)`,
      }}
    />
  </ProgressPrimitive.Root>
);

// Indeterminate oscillator progress for CloudWatch imports
const IndeterminateProgress: FC<{ className?: string }> = ({ className }) => (
  <ProgressPrimitive.Root
    className={cn('relative w-full overflow-hidden', className)}
    style={{
      height: 6,
      borderRadius: 99,
      background: 'var(--ls-bg-2)',
      border: '1px solid var(--ls-border)',
    }}
  >
    <div
      className="absolute h-full animate-[oscillate_1.5s_ease-in-out_infinite_alternate]"
      style={{ width: '33%', background: 'var(--ls-accent)' }}
    />
  </ProgressPrimitive.Root>
);

// Per-file progress row
const FileProgressRow: FC<{
  file: ImportFile;
  index: number;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ file, index, checked = true, onCheckedChange, disabled = false }) => {
  const isUploading = file.uploadStatus === 'uploading';
  const isSuccess  = file.uploadStatus === 'success';
  const isFailed   = file.uploadStatus === 'failed';
  const isPending  = file.uploadStatus === 'pending';

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const rowBg =
    isUploading ? 'var(--ls-info-soft)' :
    isSuccess   ? 'var(--ls-ok-soft)' :
    isFailed    ? 'var(--ls-err-soft)' :
    !checked    ? 'var(--ls-bg-1)' :
    'transparent';

  const fileNameColor =
    isSuccess   ? 'var(--ls-ok)' :
    isFailed    ? 'var(--ls-err)' :
    isUploading ? 'var(--ls-info)' :
    !checked    ? 'var(--ls-text-3)' :
    'var(--ls-text)';

  return (
    <div
      className="flex items-center transition-colors"
      style={{
        gap: 12,
        padding: '10px 14px',
        background: rowBg,
        opacity: !checked && isPending ? 0.6 : 1,
      }}
    >
      {/* Checkbox (pending / pre-upload) or status icon (during/after upload) */}
      <div className="flex-shrink-0 w-5 flex items-center justify-center">
        {isPending ? (
          <Checkbox
            id={`file-check-${file.id}`}
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            className="h-4 w-4"
          />
        ) : isUploading ? (
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--ls-info)' }} />
        ) : isSuccess ? (
          <CheckCircle size={14} style={{ color: 'var(--ls-ok)' }} />
        ) : (
          <XCircle size={14} style={{ color: 'var(--ls-err)' }} />
        )}
      </div>

      {/* Index */}
      <span
        className="flex-shrink-0 text-right"
        style={{
          width: 18,
          fontSize: 11,
          color: 'var(--ls-text-4)',
          fontFamily: 'var(--ls-font-mono)',
        }}
      >
        {index + 1}.
      </span>

      {/* File name + pattern badge */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label
            htmlFor={isPending ? `file-check-${file.id}` : undefined}
            className="truncate cursor-pointer"
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: fileNameColor,
            }}
          >
            {file.fileName}
          </label>
          <span
            className="inline-flex items-center flex-shrink-0"
            style={{
              padding: '1px 6px',
              borderRadius: 4,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-bg-1)',
              color: 'var(--ls-text-2)',
              fontFamily: 'var(--ls-font-mono)',
              fontSize: 10.5,
              opacity: !checked && isPending ? 0.5 : 1,
            }}
          >
            {file.selectedPattern?.name || 'No pattern'}
          </span>
        </div>

        {/* Upload progress bar */}
        {isUploading && (
          <div className="flex items-center" style={{ gap: 8, marginTop: 5 }}>
            <GreenProgress value={file.uploadProgress} className="flex-1" />
            <span
              className="text-right flex-shrink-0"
              style={{
                width: 30,
                fontSize: 10.5,
                color: 'var(--ls-info)',
                fontFamily: 'var(--ls-font-mono)',
              }}
            >
              {Math.round(file.uploadProgress)}%
            </span>
          </div>
        )}
        {isSuccess && (
          <p
            style={{
              fontSize: 11,
              color: 'var(--ls-ok)',
              marginTop: 2,
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            {file.totalLinesProcessed.toLocaleString()} lines processed
          </p>
        )}
        {isFailed && file.uploadError && (
          <p style={{ fontSize: 11, color: 'var(--ls-err)', marginTop: 2 }}>
            {file.uploadError}
          </p>
        )}
      </div>

      {/* File size */}
      <span
        className="flex-shrink-0"
        style={{
          fontSize: 11,
          color: !checked && isPending ? 'var(--ls-text-4)' : 'var(--ls-text-3)',
          fontFamily: 'var(--ls-font-mono)',
        }}
      >
        {formatSize(file.fileSize)}
      </span>
    </div>
  );
};


// Export selected file IDs so Import.tsx can read them when triggering upload
export let selectedFileIdsForImport: Set<string> | null = null;

export const ImportConfirmStep: FC = () => {
  const {
    selectedFileName,
    selectedFileHandle,
    selectedPattern,
    filePreviewBuffer,
    approxLines,
    isUploading,
    totalLines,
    uploadProgress,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    importSource,
    setApproxLines,
    metadata,
    files,
  } = useImportStore();

  const isMultiFile = importSource === 'file' && files.length > 0;

  // Track which files are checked for import (all checked by default)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(files.map(f => f.id))
  );

  // Keep the module-level reference in sync so Import.tsx can read it
  selectedFileIdsForImport = checkedIds;

  const toggleFile = (id: string, checked: boolean) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setCheckedIds(checked ? new Set(files.map(f => f.id)) : new Set());
  };

  const file = selectedFileHandle as File;
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const avgBytesPerLine = 120;
  const estimatedLines =
    approxLines > 0 ? approxLines :
    (filePreviewBuffer?.lines.length || 0) > 0 ? filePreviewBuffer.lines.length :
    Math.round((file?.size || 0) / avgBytesPerLine);

  useEffect(() => {
    if (approxLines === 0 && estimatedLines > 0) {
      setApproxLines(estimatedLines);
    }
  }, [approxLines, estimatedLines, setApproxLines]);

  // When files list changes (e.g. navigating back & forward), reset checked state
  useEffect(() => {
    setCheckedIds(new Set(files.map(f => f.id)));
  }, [files.length]);

  const { profile, region } = useCloudWatchStore();

  // Multi-file mode
  if (isMultiFile) {
    const checkedFiles = files.filter(f => checkedIds.has(f.id));
    const totalFileSize = checkedFiles.reduce((sum, f) => sum + f.fileSize, 0);
    const totalApproxLines = checkedFiles.reduce((sum, f) => sum + f.approxLines, 0);
    const successCount = files.filter(f => f.uploadStatus === 'success').length;
    const failedCount = files.filter(f => f.uploadStatus === 'failed').length;
    const uploadingFile = files.find(f => f.uploadStatus === 'uploading');
    const allChecked = files.every(f => checkedIds.has(f.id));
    const someChecked = files.some(f => checkedIds.has(f.id));

    // Overall progress across checked files only
    const overallProgress = checkedFiles.length > 0
      ? checkedFiles.reduce((sum, f) => {
          if (f.uploadStatus === 'success') return sum + 100;
          if (f.uploadStatus === 'uploading') return sum + f.uploadProgress;
          return sum;
        }, 0) / checkedFiles.length
      : 0;

    const statBoxStyle: React.CSSProperties = {
      padding: '14px 12px',
      borderRadius: 8,
      border: '1px solid var(--ls-border)',
      background: 'var(--ls-panel)',
      textAlign: 'center',
    };

    return (
      <div className="space-y-4">
        {/* Summary stats (selected files only) */}
        {!isUploading && (
          <div className="grid grid-cols-3 gap-3">
            <div style={statBoxStyle}>
              <p
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--ls-text)',
                  fontFamily: 'var(--ls-font-mono)',
                  letterSpacing: '-0.02em',
                }}
              >
                {checkedFiles.length}
              </p>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--ls-text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginTop: 2,
                }}
              >
                {checkedFiles.length === files.length ? 'Files' : `of ${files.length} Files`}
              </p>
            </div>
            <div style={statBoxStyle}>
              <p
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--ls-text)',
                  fontFamily: 'var(--ls-font-mono)',
                  letterSpacing: '-0.02em',
                }}
              >
                {formatFileSize(totalFileSize)}
              </p>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--ls-text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginTop: 2,
                }}
              >
                Total size
              </p>
            </div>
            <div style={statBoxStyle}>
              <p
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--ls-text)',
                  fontFamily: 'var(--ls-font-mono)',
                  letterSpacing: '-0.02em',
                }}
              >
                ~{totalApproxLines > 0 ? totalApproxLines.toLocaleString() : '—'}
              </p>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--ls-text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginTop: 2,
                }}
              >
                Est. lines
              </p>
            </div>
          </div>
        )}

        {/* Overall progress when uploading */}
        {isUploading && (
          <div
            className="space-y-2"
            style={{
              padding: '14px',
              borderRadius: 8,
              border: '1px solid var(--ls-border)',
              background: 'var(--ls-panel)',
            }}
          >
            <div className="flex items-center justify-between" style={{ fontSize: 12.5 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <Loader2 size={14} className="animate-spin" style={{ color: 'var(--ls-accent)' }} />
                <span style={{ fontWeight: 500, color: 'var(--ls-text)' }}>
                  Importing {uploadingFile ? `"${uploadingFile.fileName}"` : ''}…
                </span>
              </div>
              <span style={{ color: 'var(--ls-text-3)', fontFamily: 'var(--ls-font-mono)', fontSize: 11.5 }}>
                {successCount} / {checkedFiles.length} files complete
              </span>
            </div>
            <GreenProgress value={overallProgress} />
          </div>
        )}

        {/* File list with checkboxes / per-file status */}
        <div
          style={{
            borderRadius: 8,
            border: '1px solid var(--ls-border)',
            background: 'var(--ls-panel)',
            overflow: 'hidden',
          }}
        >
          {/* Header with select-all */}
          <div
            className="flex items-center"
            style={{
              gap: 12,
              padding: '8px 14px',
              background: 'var(--ls-bg-1)',
              borderBottom: '1px solid var(--ls-border)',
            }}
          >
            {!isUploading && (
              <Checkbox
                id="select-all"
                checked={allChecked}
                onCheckedChange={(v) => toggleAll(!!v)}
                className="h-4 w-4"
              />
            )}
            <label
              htmlFor={!isUploading ? 'select-all' : undefined}
              className="cursor-pointer select-none"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--ls-text-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Files to import
            </label>
            {!isUploading && someChecked && !allChecked && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: 'var(--ls-accent)',
                  fontFamily: 'var(--ls-font-mono)',
                }}
              >
                {checkedIds.size} selected
              </span>
            )}
          </div>

          {files.map((f, i) => (
            <div
              key={f.id}
              style={{
                borderBottom: i < files.length - 1 ? '1px solid var(--ls-border-subtle)' : 'none',
              }}
            >
              <FileProgressRow
                file={f}
                index={i}
                checked={checkedIds.has(f.id)}
                onCheckedChange={(v) => toggleFile(f.id, !!v)}
                disabled={isUploading}
              />
            </div>
          ))}
        </div>

        {/* Errors summary */}
        {failedCount > 0 && !isUploading && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: 'var(--ls-err-soft)',
              border: '1px solid color-mix(in srgb, var(--ls-err) 25%, transparent)',
            }}
          >
            <p style={{ fontSize: 12.5, color: 'var(--ls-err)', fontWeight: 500 }}>
              {failedCount} file{failedCount !== 1 ? 's' : ''} failed to import
            </p>
          </div>
        )}

        {/* Nothing selected warning */}
        {!isUploading && checkedIds.size === 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: 'var(--ls-warn-soft)',
              border: '1px solid color-mix(in srgb, var(--ls-warn) 25%, transparent)',
            }}
          >
            <p style={{ fontSize: 12.5, color: 'var(--ls-warn)' }}>
              Select at least one file to import.
            </p>
          </div>
        )}
      </div>
    );
  }

  // --- Legacy single-file / CloudWatch mode ---

  const sourceIcon = importSource === 'cloudwatch'
    ? <Cloud size={15} style={{ color: 'var(--ls-accent)' }} />
    : <FileText size={15} style={{ color: 'var(--ls-accent)' }} />;

  const sourceTitle = importSource === 'cloudwatch'
    ? 'CloudWatch logs information'
    : 'File information';

  const showIndeterminateProgress = importSource === 'cloudwatch' && isUploading;
  const showProgressBar = importSource !== 'cloudwatch' && isUploading;

  const sectionStyle: React.CSSProperties = {
    padding: 16,
    borderRadius: 8,
    border: '1px solid var(--ls-border)',
    background: 'var(--ls-panel)',
  };
  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ls-text)',
    letterSpacing: '-0.005em',
  };
  const kvKeyStyle: React.CSSProperties = {
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--ls-text-3)',
    padding: '4px 0',
    width: 200,
    verticalAlign: 'top',
  };
  const kvValueStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--ls-text)',
    padding: '4px 0',
    fontFamily: 'var(--ls-font-mono)',
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div style={sectionStyle}>
          <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
            {sourceIcon}
            <h3 style={sectionTitleStyle}>{sourceTitle}</h3>
          </div>
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {importSource === 'cloudwatch' && (
                <>
                  <tr>
                    <td style={kvKeyStyle}>CloudWatch region</td>
                    <td style={kvValueStyle}>{region}</td>
                  </tr>
                  <tr>
                    <td style={kvKeyStyle}>CloudWatch profile</td>
                    <td style={kvValueStyle}>{profile}</td>
                  </tr>
                  <tr>
                    <td style={kvKeyStyle}>Stream name</td>
                    <td style={kvValueStyle}>{selectedFileName}</td>
                  </tr>
                </>
              )}
              {importSource === 'file' && (
                <>
                  <tr>
                    <td style={kvKeyStyle}>File name</td>
                    <td style={kvValueStyle}>{selectedFileName}</td>
                  </tr>
                  <tr>
                    <td style={kvKeyStyle}>File size</td>
                    <td style={kvValueStyle}>{file ? formatFileSize(file.size) : 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style={kvKeyStyle}>Total lines</td>
                    <td style={kvValueStyle}>{approxLines.toLocaleString()} lines estimated</td>
                  </tr>
                </>
              )}
              <tr>
                <td style={kvKeyStyle}>Smart decoder</td>
                <td style={kvValueStyle}>{sessionOptionsSmartDecoder ? 'Yes' : 'No'}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Force timezone</td>
                <td style={kvValueStyle}>{sessionOptionsTimezone || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Force year</td>
                <td style={kvValueStyle}>{sessionOptionsYear || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Force month</td>
                <td style={kvValueStyle}>{sessionOptionsMonth || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Force day</td>
                <td style={kvValueStyle}>{sessionOptionsDay || 'Auto-detect'}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Metadata</td>
                <td style={kvValueStyle}>{JSON.stringify(metadata)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={sectionStyle}>
          <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
            <Code size={15} style={{ color: 'var(--ls-accent)' }} />
            <h3 style={sectionTitleStyle}>Pattern information</h3>
          </div>
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr>
                <td style={kvKeyStyle}>Pattern name</td>
                <td style={kvValueStyle}>{selectedPattern?.name}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Description</td>
                <td style={{ ...kvValueStyle, fontFamily: 'var(--ls-font-sans)' }}>
                  {selectedPattern?.description}
                </td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Priority</td>
                <td style={kvValueStyle}>{selectedPattern?.priority}</td>
              </tr>
              <tr>
                <td style={kvKeyStyle}>Extracted fields</td>
                <td style={{ ...kvValueStyle, padding: '6px 0' }}>
                  {selectedPattern?.fields?.length ? (
                    <span className="inline-flex flex-wrap" style={{ gap: 4 }}>
                      {selectedPattern.fields.map((f) => (
                        <span
                          key={f}
                          className="inline-flex items-center"
                          style={{
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'var(--ls-accent-softer)',
                            border: '1px solid var(--ls-accent-border)',
                            color: 'var(--ls-accent-text)',
                            fontSize: 10.5,
                            fontFamily: 'var(--ls-font-mono)',
                          }}
                        >
                          {f}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <div style={{ marginTop: 10 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--ls-text-3)',
                marginBottom: 4,
              }}
            >
              Pattern
            </div>
            <div
              className="overflow-x-auto"
              style={{
                padding: '8px 10px',
                fontSize: 11.5,
                fontFamily: 'var(--ls-font-mono)',
                color: 'var(--ls-text-2)',
                borderRadius: 6,
                border: '1px solid var(--ls-border)',
                background: 'var(--ls-bg-1)',
              }}
            >
              {selectedPattern?.pattern}
            </div>
          </div>

          {selectedPattern?.custom_patterns && Object.keys(selectedPattern.custom_patterns).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--ls-text-3)',
                  marginBottom: 4,
                }}
              >
                Custom patterns
              </div>
              <div
                style={{
                  borderRadius: 6,
                  border: '1px solid var(--ls-border)',
                  background: 'var(--ls-bg-1)',
                  overflow: 'hidden',
                }}
              >
                <table className="w-full" style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 11.5 }}>
                  <tbody>
                    {Object.entries(selectedPattern.custom_patterns).map(([name, pattern], i, arr) => (
                      <tr
                        key={name}
                        style={{
                          borderBottom: i < arr.length - 1 ? '1px solid var(--ls-border-subtle)' : 'none',
                        }}
                      >
                        <td
                          style={{
                            padding: '6px 10px',
                            width: 160,
                            whiteSpace: 'nowrap',
                            color: 'var(--ls-text-3)',
                          }}
                        >
                          {name}
                        </td>
                        <td style={{ padding: '6px 10px', overflowX: 'auto', color: 'var(--ls-text)' }}>
                          {pattern}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {showProgressBar && (
        <div
          className="space-y-2"
          style={{
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--ls-border)',
            background: 'var(--ls-panel)',
          }}
        >
          <div className="flex items-center justify-between" style={{ fontSize: 12.5 }}>
            <span style={{ fontWeight: 500, color: 'var(--ls-text)' }}>Uploading…</span>
            <span style={{ fontWeight: 500, color: 'var(--ls-accent)', fontFamily: 'var(--ls-font-mono)' }}>
              {Math.round(uploadProgress)}%
            </span>
          </div>
          <GreenProgress value={uploadProgress} />
          <div className="flex items-center justify-center" style={{ gap: 6, fontSize: 12, color: 'var(--ls-text-3)' }}>
            <Loader2 size={13} className="animate-spin" />
            <span>Processing file, please wait…</span>
          </div>
        </div>
      )}

      {showIndeterminateProgress && (
        <div
          className="space-y-2"
          style={{
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--ls-border)',
            background: 'var(--ls-panel)',
          }}
        >
          <div className="flex items-center justify-between" style={{ fontSize: 12.5 }}>
            <span style={{ fontWeight: 500, color: 'var(--ls-text)' }}>
              Retrieving CloudWatch logs…
            </span>
            <span style={{ fontWeight: 500, color: 'var(--ls-accent)', fontFamily: 'var(--ls-font-mono)' }}>
              {totalLines.toLocaleString()} lines ingested
            </span>
          </div>
          <IndeterminateProgress />
          <div className="flex items-center justify-center" style={{ gap: 6, fontSize: 12, color: 'var(--ls-text-3)' }}>
            <Loader2 size={13} className="animate-spin" />
            <span>Processing logs, please wait…</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImportConfirmStep;
