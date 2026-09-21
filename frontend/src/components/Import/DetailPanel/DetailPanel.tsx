import { ArrowLeft } from 'lucide-react';
import { FC } from 'react';

import { formatSize } from '../utils/importGate';

import { OptionsTab } from './OptionsTab';
import { PatternTab } from './PatternTab';
import { TimestampTab } from './TimestampTab';

import type { ImportFile, Pattern } from '../types';

import { useImportStore, type DetailTab } from '@/stores/useImportStore';

interface DetailPanelProps {
  file: ImportFile;
  files: ImportFile[];
  onBack: () => void;
  onChangePattern: (fileId: string, pattern: Pattern) => Promise<void>;
}

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'pattern', label: 'Pattern' },
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'options', label: 'Options' },
];

/**
 * Per-file configuration, one interaction deep: swaps in over the file
 * list (same pane); the Import action stays put in the topbar.
 */
export const DetailPanel: FC<DetailPanelProps> = ({ file, files, onBack, onChangePattern }) => {
  const tab = useImportStore((s) => s.detailTab);
  const setTab = useImportStore((s) => s.setDetailTab);
  const needsTs =
    file.timestampInference &&
    (file.timestampInference.status === 'ambiguous' ||
      file.timestampInference.status === 'missing') &&
    !file.timestampConfirmed;

  return (
    <section className="ls-imp-pane ls-rise" aria-label={`Configure ${file.fileName}`}>
      <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--ls-border-subtle)' }}>
        <button
          type="button"
          className="ls-imp-link inline-flex items-center"
          style={{ gap: 4 }}
          onClick={onBack}
        >
          <ArrowLeft size={12} /> Back to files
        </button>
        <div
          className="truncate"
          style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--ls-text)' }}
          title={file.nativePath || file.fileName}
        >
          {file.fileName}
        </div>
        <div
          className="ls-imp-mono"
          style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ls-text-3)' }}
        >
          {file.fileSize > 0 ? `${formatSize(file.fileSize)} · ` : ''}
          {file.approxLines > 0 ? `~${file.approxLines.toLocaleString()} lines` : 'reading…'}
        </div>
      </div>

      <div className="ls-imp-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`ls-imp-tab${tab === t.id ? ' ls-imp-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'timestamp' && needsTs && (
              <span style={{ marginLeft: 5, color: 'var(--ls-warn)' }} aria-label="needs attention">
                ●
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="ls-imp-pane-scroll" style={{ padding: 14 }}>
        {tab === 'pattern' && <PatternTab file={file} onChangePattern={onChangePattern} />}
        {tab === 'timestamp' && <TimestampTab file={file} fileCount={files.length} />}
        {tab === 'options' && <OptionsTab file={file} fileCount={files.length} />}
      </div>
    </section>
  );
};

export default DetailPanel;
