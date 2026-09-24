import { ReactNode, useCallback, useRef, useState } from 'react';

import { ACCEPT_ATTR } from './useFileIntake';

/**
 * The hidden multi-file <input> plus the handlers a drop target needs.
 * Shared by the empty-state zone and the file list's "Add" button so the
 * accept list, the reset-after-pick and the drag bookkeeping live once.
 */
export function useFilePicker(onFiles: (files: File[]) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

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
  const browse = useCallback(() => inputRef.current?.click(), []);

  const input: ReactNode = (
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

  return { input, browse, over, dropHandlers: { onDragOver, onDragLeave, onDrop } };
}
