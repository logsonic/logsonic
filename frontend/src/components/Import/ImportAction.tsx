import { FC } from 'react';

import { formatSize } from './utils/importGate';

import type { ImportFile } from './types';
import type { ImportGate } from './utils/importGate';

interface ImportActionProps {
  files: ImportFile[];
  gate: ImportGate;
  onImport: () => void;
}

/**
 * The commit action, pinned to the topbar's right edge so it is in the same
 * place whichever pane is showing. The caption beside it is the staged total
 * or, while the gate is closed, the reason the button is disabled.
 */
export const ImportAction: FC<ImportActionProps> = ({ files, gate, onImport }) => {
  const lines = files.reduce((s, f) => s + (f.approxLines || 0), 0);
  const bytes = files.reduce((s, f) => s + (f.fileSize || 0), 0);
  const summary = `${lines > 0 ? `~${lines.toLocaleString()} lines` : 'reading…'}${
    bytes > 0 ? ` · ${formatSize(bytes)}` : ''
  }`;
  return (
    <div className="ls-imp-action">
      <span
        className="ls-imp-mono ls-imp-action-meta"
        style={{ color: gate.reason ? 'var(--ls-err)' : 'var(--ls-text-3)' }}
        role={gate.reason ? 'status' : undefined}
      >
        {gate.reason ?? summary}
      </span>
      <button
        type="button"
        className="ls-imp-primary"
        disabled={gate.disabled}
        onClick={onImport}
        title={gate.reason ?? undefined}
      >
        Import {files.length} file{files.length === 1 ? '' : 's'}
      </button>
    </div>
  );
};

export default ImportAction;
