import { ArrowDown } from 'lucide-react';
import { FC } from 'react';

import { useFilePicker } from './hooks/useFilePicker';

interface DropZoneProps {
  native: boolean;
  onFiles: (files: File[]) => void;
}

/**
 * The empty state: a tall centered drop target. Clicking anywhere opens
 * the picker; drag-over is a visual state only. Once files exist this is
 * gone — the file list's "Add" button and drop target take over.
 */
export const DropZone: FC<DropZoneProps> = ({ native, onFiles }) => {
  const { input, browse, over, dropHandlers } = useFilePicker(onFiles);

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center ls-rise ls-imp-dropwrap"
      style={{ gap: 22 }}
    >
      <div
        className={`ls-imp-dropzone${over ? ' ls-imp-dropzone--over' : ''}`}
        {...dropHandlers}
        onClick={browse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') browse();
        }}
      >
        {input}
        <div className="ls-imp-drop-icon">
          <ArrowDown size={26} strokeWidth={2.4} />
        </div>
        <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.3, color: 'var(--ls-text)' }}>
          Drop log files here to get started
        </div>
        <div style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.5, color: 'var(--ls-text-2)' }}>
          {/* The handoff's "drop a folder from Finder" copy is not true yet:
              window drops are scheduled for macos-b3, and a drop here still
              goes through the browser File route. Dock / Open With hand
              over paths (now-08), which is what "read in place" means. */}
          {native
            ? 'or click to browse · files opened via the Dock or Finder are read in place'
            : 'or click to browse · detection starts the moment files land'}
        </div>
        <div className="flex justify-center" style={{ gap: 7, marginTop: 18 }}>
          <span className="ls-imp-pill">.log</span>
          <span className="ls-imp-pill">.txt</span>
          <span className="ls-imp-pill">.json</span>
        </div>
      </div>
      <div className="ls-imp-mono" style={{ fontSize: 12, color: 'var(--ls-text-3)' }}>
        up to 5 GiB per file · detection runs automatically
      </div>
    </div>
  );
};

export default DropZone;
