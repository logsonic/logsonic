import { RefreshCw } from 'lucide-react';
import { FC, useState } from 'react';

import { FileRow } from './FileRow';
import { ImportFooter } from './ImportFooter';

import type { ImportFile, Pattern } from '../types';
import type { ImportGate } from '../utils/importGate';

interface FileListProps {
  files: ImportFile[];
  selectedId: string | null;
  gate: ImportGate;
  onSelect: (id: string) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
  onApplyPatternToAll: (pattern: Pattern) => Promise<void>;
  onRedetectAll: () => void;
  onImport: () => void;
}

/**
 * Left pane in the default working state: every added file with its
 * verdict, the batch "apply pattern to all" link, and the sticky import
 * footer.
 */
export const FileList: FC<FileListProps> = ({
  files,
  selectedId,
  gate,
  onSelect,
  onConfigure,
  onRemove,
  onApplyPatternToAll,
  onRedetectAll,
  onImport,
}) => {
  const [applied, setApplied] = useState<string | null>(null);
  const detected = files.filter((f) => f.detectionStatus === 'detected').length;
  const failed = files.filter((f) => f.detectionStatus === 'failed').length;
  const busy = files.length - detected - failed;
  const selected = files.find((f) => f.id === selectedId) ?? null;
  const batchPattern =
    files.length > 1 && selected?.selectedPattern && selected.detectionStatus === 'detected'
      ? selected.selectedPattern
      : null;
  // Only offer the batch action when it would change something.
  const batchUseful =
    !!batchPattern && files.some((f) => f.selectedPattern?.pattern !== batchPattern.pattern);

  return (
    <section className="ls-imp-pane" aria-label="Files">
      <div className="ls-imp-pane-head" style={{ padding: '13px 14px 9px' }}>
        <span className="ls-imp-label">Files</span>
        {busy > 0 ? (
          <span className="ls-imp-count ls-imp-count--busy">{busy} detecting</span>
        ) : (
          <span className="ls-imp-count">{detected} detected</span>
        )}
        {failed > 0 && (
          <span className="ls-imp-count ls-imp-count--warn">{failed} need attention</span>
        )}
        <button
          type="button"
          className="ls-imp-cfg-btn ml-auto"
          title="Re-detect all files"
          aria-label="Re-detect all files"
          onClick={onRedetectAll}
          disabled={busy > 0}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="ls-imp-pane-scroll" style={{ padding: '10px 10px 4px' }}>
        {files.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            selected={f.id === selectedId}
            onSelect={() => onSelect(f.id)}
            onConfigure={() => onConfigure(f.id)}
            onRemove={() => onRemove(f.id)}
          />
        ))}
      </div>

      {batchPattern && (
        <div className="ls-imp-pane-foot" style={{ padding: '9px 14px' }}>
          {applied === batchPattern.name && !batchUseful ? (
            <span style={{ fontSize: 11.5, color: 'var(--ls-ok)' }}>
              ✓ Applied {batchPattern.name} to all {files.length} files
            </span>
          ) : (
            <button
              type="button"
              className="ls-imp-link"
              disabled={!batchUseful}
              onClick={async () => {
                await onApplyPatternToAll(batchPattern);
                setApplied(batchPattern.name);
              }}
            >
              Apply {batchPattern.name} to all {files.length} files
            </button>
          )}
        </div>
      )}

      <ImportFooter files={files} gate={gate} onImport={onImport} />
    </section>
  );
};

export default FileList;
