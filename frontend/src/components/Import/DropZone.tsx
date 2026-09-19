import { ArrowDown } from 'lucide-react';
import { FC, useCallback, useRef, useState } from 'react';

import { ACCEPT_ATTR } from './hooks/useFileIntake';

interface DropZoneProps {
  fileCount: number;
  native: boolean;
  onFiles: (files: File[]) => void;
}

/**
 * Two shapes, one drop target: the tall centered zone before any file is
 * added, and the compact "drop more" strip once the split pane is up.
 * Clicking anywhere opens the picker; drag-over is a visual state only.
 */
export const DropZone: FC<DropZoneProps> = ({ fileCount, native, onFiles }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hasFiles = fileCount > 0;

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const dropped = Array.from(e.dataTransfer.files);
      if (dropped.length > 0) onFiles(dropped);
    },
    [onFiles]
  );
  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files || []);
      if (picked.length > 0) onFiles(picked);
      // Reset so the same file(s) can be selected again.
      if (inputRef.current) inputRef.current.value = '';
    },
    [onFiles]
  );
  const browse = () => inputRef.current?.click();

  const input = (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      accept={ACCEPT_ATTR}
      multiple
      onChange={onPick}
      aria-label="Choose log files"
    />
  );

  if (!hasFiles) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center ls-rise"
        style={{ gap: 22, padding: '48px 24px' }}
      >
        <div
          className={`ls-imp-dropzone${over ? ' ls-imp-dropzone--over' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
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
  }

  return (
    <div style={{ padding: '10px 14px' }}>
      <div
        className={`ls-imp-dropstrip${over ? ' ls-imp-dropzone--over' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={browse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') browse();
        }}
      >
        {input}
        <ArrowDown size={14} style={{ color: 'var(--ls-accent)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text-2)' }}>
          Drop more files
        </span>
        <span style={{ color: 'var(--ls-text-4)' }}>·</span>
        <span className="ls-imp-mono" style={{ fontSize: 12, color: 'var(--ls-text-3)' }}>
          {fileCount} selected
        </span>
        <span
          className="ml-auto"
          style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ls-accent)' }}
        >
          browse…
        </span>
      </div>
    </div>
  );
};

export default DropZone;
