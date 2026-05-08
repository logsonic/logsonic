import { getSystemInfo } from '@/lib/api-client';
import { useImportStore } from '@/stores/useImportStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import { CheckCircle, Cloud, File, XCircle } from 'lucide-react';
import { FC, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const StatBox: FC<{ value: string | number; label: string; valueColor?: string }> = ({
  value,
  label,
  valueColor,
}) => (
  <div
    style={{
      padding: '14px 12px',
      borderRadius: 8,
      border: '1px solid var(--ls-border)',
      background: 'var(--ls-panel)',
      textAlign: 'center',
    }}
  >
    <p
      style={{
        fontSize: 22,
        fontWeight: 700,
        fontFamily: 'var(--ls-font-mono)',
        letterSpacing: '-0.02em',
        color: valueColor || 'var(--ls-text)',
      }}
    >
      {value}
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
      {label}
    </p>
  </div>
);

export const SuccessSummary: FC = () => {
  const {
    selectedFileName,
    importSource,
    sessionOptionsFileName,
    selectedPattern,
    totalLines,
    reset,
    files,
  } = useImportStore();
  const navigate = useNavigate();
  const { setSystemInfo } = useSystemInfoStore();
  const [redirectCounter, setRedirectCounter] = useState(5);
  const searchQueryParamsStore = useSearchQueryParamsStore();

  const isMultiFile = importSource === 'file' && files.length > 0;

  const successFiles = useMemo(() => files.filter(f => f.uploadStatus === 'success'), [files]);
  const failedFiles = useMemo(() => files.filter(f => f.uploadStatus === 'failed'), [files]);
  const totalLinesProcessed = useMemo(
    () => isMultiFile ? files.reduce((sum, f) => sum + f.totalLinesProcessed, 0) : totalLines,
    [isMultiFile, files, totalLines]
  );

  const allSuccess = failedFiles.length === 0;

  useEffect(() => {
    const invalidateInfo = async () => {
      const info = await getSystemInfo(true);
      setSystemInfo(info);
    };
    invalidateInfo();
    searchQueryParamsStore.resetStore();

    const timer = setInterval(() => {
      setRedirectCounter(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          reset();
          navigate('/');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate, setSystemInfo]);

  // Multi-file results
  if (isMultiFile) {
    return (
      <div className="space-y-5 py-2">
        <div className="flex flex-col items-center text-center">
          <div
            className="inline-flex items-center justify-center"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: allSuccess ? 'var(--ls-ok-soft)' : 'var(--ls-warn-soft)',
              border: `1px solid ${
                allSuccess
                  ? 'color-mix(in srgb, var(--ls-ok) 25%, transparent)'
                  : 'color-mix(in srgb, var(--ls-warn) 25%, transparent)'
              }`,
              marginBottom: 12,
            }}
          >
            {allSuccess ? (
              <CheckCircle size={22} style={{ color: 'var(--ls-ok)' }} />
            ) : (
              <div className="relative">
                <CheckCircle size={22} style={{ color: 'var(--ls-ok)' }} />
                <XCircle
                  size={12}
                  style={{
                    color: 'var(--ls-err)',
                    background: 'var(--ls-panel)',
                    borderRadius: '50%',
                    position: 'absolute',
                    right: -4,
                    bottom: -2,
                  }}
                />
              </div>
            )}
          </div>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--ls-text)',
              letterSpacing: '-0.01em',
              marginBottom: 4,
            }}
          >
            {allSuccess ? 'Import successful' : 'Import complete'}
          </h2>
          <p style={{ fontSize: 12.5, color: 'var(--ls-text-2)' }}>
            {allSuccess
              ? `All ${files.length} files have been imported.`
              : `${successFiles.length} of ${files.length} files imported successfully.`}{' '}
            Redirecting in {redirectCounter}s…
          </p>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-3 max-w-lg mx-auto">
          <StatBox value={successFiles.length} label="Succeeded" valueColor="var(--ls-ok)" />
          {failedFiles.length > 0 ? (
            <StatBox value={failedFiles.length} label="Failed" valueColor="var(--ls-err)" />
          ) : (
            <StatBox value={files.length} label="Files" />
          )}
          <StatBox
            value={totalLinesProcessed.toLocaleString()}
            label="Lines processed"
          />
        </div>

        {/* Per-file results */}
        <div
          className="max-w-2xl mx-auto"
          style={{
            borderRadius: 8,
            border: '1px solid var(--ls-border)',
            background: 'var(--ls-panel)',
            overflow: 'hidden',
          }}
        >
          {files.map((f, i) => (
            <div
              key={f.id}
              className="flex items-center"
              style={{
                gap: 10,
                padding: '10px 14px',
                borderBottom:
                  i < files.length - 1 ? '1px solid var(--ls-border-subtle)' : 'none',
              }}
            >
              {f.uploadStatus === 'success' ? (
                <CheckCircle size={14} style={{ color: 'var(--ls-ok)', flexShrink: 0 }} />
              ) : (
                <XCircle size={14} style={{ color: 'var(--ls-err)', flexShrink: 0 }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center" style={{ gap: 6 }}>
                  <File size={12} style={{ color: 'var(--ls-text-3)', flexShrink: 0 }} />
                  <span
                    className="truncate"
                    style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}
                  >
                    {f.fileName}
                  </span>
                </div>
              </div>
              <span
                className="inline-flex items-center flex-shrink-0"
                style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  border: '1px solid var(--ls-border)',
                  background: 'var(--ls-bg-1)',
                  color: 'var(--ls-text-2)',
                  fontSize: 10.5,
                  fontFamily: 'var(--ls-font-mono)',
                }}
              >
                {f.selectedPattern?.name || 'Unknown'}
              </span>
              {f.uploadStatus === 'success' && (
                <span
                  className="flex-shrink-0"
                  style={{
                    fontSize: 11,
                    color: 'var(--ls-text-3)',
                    fontFamily: 'var(--ls-font-mono)',
                  }}
                >
                  {f.totalLinesProcessed.toLocaleString()} lines
                </span>
              )}
              {f.uploadStatus === 'failed' && (
                <span
                  className="truncate flex-shrink-0"
                  style={{ fontSize: 11, color: 'var(--ls-err)', maxWidth: 200 }}
                >
                  {f.uploadError || 'Failed'}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Legacy single-file / CloudWatch results
  const sourceIcon = importSource === 'cloudwatch'
    ? <Cloud size={14} style={{ color: 'var(--ls-accent)' }} />
    : <File size={14} style={{ color: 'var(--ls-accent)' }} />;

  const fileLabel = importSource === 'cloudwatch' ? 'CloudWatch log' : 'File name';
  const fileName = importSource === 'cloudwatch' ? sessionOptionsFileName : selectedFileName;

  return (
    <div className="space-y-5 py-2">
      <div className="flex flex-col items-center text-center">
        <div
          className="inline-flex items-center justify-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'var(--ls-ok-soft)',
            border: '1px solid color-mix(in srgb, var(--ls-ok) 25%, transparent)',
            marginBottom: 12,
          }}
        >
          <CheckCircle size={22} style={{ color: 'var(--ls-ok)' }} />
        </div>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--ls-text)',
            letterSpacing: '-0.01em',
            marginBottom: 4,
          }}
        >
          Import successful
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          Your logs have been processed. Redirecting in {redirectCounter}s…
        </p>
      </div>

      <div
        className="max-w-md mx-auto"
        style={{
          padding: 16,
          borderRadius: 8,
          border: '1px solid var(--ls-border)',
          background: 'var(--ls-panel)',
        }}
      >
        <div
          className="flex items-center justify-between"
          style={{ padding: '4px 0' }}
        >
          <span className="inline-flex items-center" style={{ gap: 6 }}>
            {sourceIcon}
            <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>
              {fileLabel}
            </span>
          </span>
          <span style={{ fontSize: 12, color: 'var(--ls-text)', fontFamily: 'var(--ls-font-mono)' }}>
            {fileName}
          </span>
        </div>
        <div
          className="flex items-center justify-between"
          style={{ padding: '4px 0', borderTop: '1px solid var(--ls-border-subtle)', marginTop: 4 }}
        >
          <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>Pattern</span>
          <span style={{ fontSize: 12, color: 'var(--ls-text)', fontFamily: 'var(--ls-font-mono)' }}>
            {selectedPattern?.name}
          </span>
        </div>
        <div
          className="flex items-center justify-between"
          style={{ padding: '4px 0', borderTop: '1px solid var(--ls-border-subtle)' }}
        >
          <span style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>Lines processed</span>
          <span style={{ fontSize: 12, color: 'var(--ls-text)', fontFamily: 'var(--ls-font-mono)' }}>
            {totalLines.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SuccessSummary;
