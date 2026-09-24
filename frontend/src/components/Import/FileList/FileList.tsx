import { Plus, RefreshCw } from 'lucide-react';
import { FC, useState } from 'react';

import { useFilePicker } from '../hooks/useFilePicker';

import { FileRow } from './FileRow';

import type { ImportFile, Pattern } from '../types';

interface FileListProps {
  files: ImportFile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onApplyPatternToAll: (pattern: Pattern) => Promise<void>;
  onRedetectAll: () => void;
}

/**
 * Left pane in the default working state: every added file with its
 * verdict and the batch "apply pattern to all" link. Once files exist
 * this pane is the only way in for more: the Add button, or dropping
 * onto the list.
 */
export const FileList: FC<FileListProps> = ({
  files,
  selectedId,
  onSelect,
  onConfigure,
  onRemove,
  onAddFiles,
  onApplyPatternToAll,
  onRedetectAll,
}) => {
  const [applied, setApplied] = useState<string | null>(null);
  const { input, browse, over, dropHandlers } = useFilePicker(onAddFiles);
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
    <section
      className={`ls-imp-pane${over ? ' ls-imp-pane--over' : ''}`}
      aria-label="Files"
      {...dropHandlers}
    >
      {input}
      <div className="ls-imp-pane-head" style={{ padding: '12px 14px 9px' }}>
        <span className="ls-imp-label">Files</span>
        <span className="ls-imp-mono" style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>
          {files.length}
        </span>
        <button
          type="button"
          className="ls-imp-cfg-btn ml-auto"
          title="Add more files (or drop them onto this list)"
          aria-label="Add files"
          onClick={browse}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="ls-imp-cfg-btn"
          title="Re-detect all files"
          aria-label="Re-detect all files"
          onClick={onRedetectAll}
          disabled={busy > 0}
        >
          <RefreshCw size={12} className={busy > 0 ? 'animate-spin' : undefined} />
        </button>
      </div>
      {/* Verdict summary under the head: pills wrap rather than fight the
          re-detect button for the rail's width. */}
      <div className="flex flex-wrap" style={{ gap: 6, padding: '9px 14px 0' }}>
        {busy > 0 ? (
          <span className="ls-imp-count ls-imp-count--busy">{busy} detecting</span>
        ) : (
          <span className="ls-imp-count">{detected} detected</span>
        )}
        {failed > 0 && (
          <span className="ls-imp-count ls-imp-count--warn">{failed} need attention</span>
        )}
      </div>

      <div className="ls-imp-pane-scroll ls-imp-filelist" style={{ padding: '8px 10px 4px' }}>
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
    </section>
  );
};

export default FileList;
