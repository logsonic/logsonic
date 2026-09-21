import { Settings2, Trash2 } from 'lucide-react';
import { FC } from 'react';

import { matchRateOf } from '../hooks/useFileDetection';
import { formatSize, matchColor } from '../utils/importGate';

import type { ImportFile } from '../types';

interface FileRowProps {
  file: ImportFile;
  selected: boolean;
  onSelect: () => void;
  onConfigure: () => void;
  onRemove: () => void;
}

export const FileRow: FC<FileRowProps> = ({ file, selected, onSelect, onConfigure, onRemove }) => {
  const busy = file.detectionStatus === 'detecting' || file.detectionStatus === 'pending';
  const failed = file.detectionStatus === 'failed';
  const rate =
    file.detectionStatus === 'detected' ? matchRateOf(file.parsedLogs, file.previewLines) : 0;
  const color = failed ? 'var(--ls-err)' : matchColor(rate);
  const tsAttention =
    file.timestampInference &&
    (file.timestampInference.status === 'ambiguous' ||
      file.timestampInference.status === 'missing') &&
    !file.timestampConfirmed;

  return (
    <div
      className={`ls-imp-filerow${selected ? ' ls-imp-filerow--selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        className={`ls-imp-dot${busy ? ' ls-imp-dot--busy' : ''}`}
        style={busy ? undefined : { background: color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {/* The action buttons sit over the top-right corner; the name line
            reserves their width so nothing hides under them. */}
        <div
          className="truncate ls-imp-row-name"
          style={{ fontSize: 13, fontWeight: 600, color: 'var(--ls-text)' }}
          title={file.nativePath || file.fileName}
        >
          {file.fileName}
        </div>
        <div
          className="ls-imp-mono flex items-baseline"
          style={{ gap: 6, fontSize: 11.5, marginTop: 2 }}
        >
          {busy ? (
            <span style={{ color: 'var(--ls-info)' }}>Detecting…</span>
          ) : failed ? (
            <span className="truncate" style={{ color: 'var(--ls-err)' }}>
              {file.selectedPattern && file.selectedPattern.name !== 'Custom Pattern'
                ? `${file.selectedPattern.name} · failed`
                : 'Detection failed'}
            </span>
          ) : (
            <>
              <span className="truncate" style={{ color }}>
                {file.selectedPattern?.name ?? 'no pattern'}
              </span>
              <span className="flex-shrink-0" style={{ color }}>
                · {rate}%
              </span>
            </>
          )}
          {tsAttention && (
            <span
              className="flex-shrink-0"
              style={{ color: 'var(--ls-warn)' }}
              title="Timestamp needs confirmation"
            >
              ⚠ timestamp
            </span>
          )}
          {(file.fileSize > 0 || file.approxLines > 0) && (
            <span
              className="ls-imp-rail-aux ml-auto flex-shrink-0"
              style={{ color: 'var(--ls-text-4)' }}
            >
              {file.fileSize > 0 ? formatSize(file.fileSize) : ''}
              {file.fileSize > 0 && file.approxLines > 0 ? ' · ' : ''}
              {file.approxLines > 0 ? `~${file.approxLines.toLocaleString()} lines` : ''}
            </span>
          )}
        </div>
        {!busy && !failed && (
          <div className="ls-imp-matchbar" aria-hidden>
            <div style={{ width: `${rate}%`, background: color }} />
          </div>
        )}
      </div>
      <div className="ls-imp-row-actions">
        <button
          type="button"
          className="ls-imp-cfg-btn"
          title="Configure pattern, timestamp and options"
          aria-label={`Configure ${file.fileName}`}
          onClick={(e) => {
            e.stopPropagation();
            onConfigure();
          }}
        >
          <Settings2 size={13} />
        </button>
        <button
          type="button"
          className="ls-imp-cfg-btn danger"
          title="Remove file"
          aria-label={`Remove ${file.fileName}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
};

export default FileRow;
