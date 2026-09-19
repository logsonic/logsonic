import { FC } from 'react';

import { formatSize } from '../utils/importGate';

import type { ImportFile } from '../types';
import type { ImportGate } from '../utils/importGate';

interface ImportFooterProps {
  files: ImportFile[];
  gate: ImportGate;
  onImport: () => void;
}

// Sticky CTA under both the file list and the detail panel, so "Import N
// files" is one click away from every state of the left pane.
export const ImportFooter: FC<ImportFooterProps> = ({ files, gate, onImport }) => {
  const lines = files.reduce((s, f) => s + (f.approxLines || 0), 0);
  const bytes = files.reduce((s, f) => s + (f.fileSize || 0), 0);
  const label =
    gate.disabled && gate.reason
      ? 'Import blocked'
      : `Import ${files.length} file${files.length === 1 ? '' : 's'}`;
  return (
    <div className="ls-imp-foot">
      <button type="button" className="ls-imp-primary" disabled={gate.disabled} onClick={onImport}>
        {label}
      </button>
      <div
        className="ls-imp-mono"
        style={{
          marginTop: 8,
          textAlign: 'center',
          fontSize: 11.5,
          color: gate.reason ? 'var(--ls-err)' : 'var(--ls-text-3)',
        }}
      >
        {gate.reason ??
          `${lines > 0 ? `~${lines.toLocaleString()} lines` : 'reading…'}${bytes > 0 ? ` · ${formatSize(bytes)}` : ''}`}
      </div>
    </div>
  );
};

export default ImportFooter;
