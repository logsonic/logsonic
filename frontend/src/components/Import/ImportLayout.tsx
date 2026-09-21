import { ArrowLeft } from 'lucide-react';
import { FC, ReactNode } from 'react';

import { isNativeShell } from '@/lib/native';

// Traffic lights are inset over the top-left corner in the native shell
// (macos-b1); the breadcrumb starts past the zone Home.tsx reserves for
// them (TRAFFIC_LIGHT_ZONE_W there) plus the same 8px safety margin.
const NATIVE_LEFT_INSET = 78 + 8;

interface ImportLayoutProps {
  fileCount: number;
  // Label for the right-hand action: "Cancel" while files are staged,
  // "Back to home" otherwise.
  onLeave: () => void;
  leaveLabel: string;
  leaveDisabled?: boolean;
  // Right-edge commit action (the Import button) while files are staged.
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Full-viewport shell for the import surface: the same topbar chrome the
 * Home and Settings pages use (breadcrumb, token colors, native drag
 * region) over a body that fills the rest of the window.
 */
export const ImportLayout: FC<ImportLayoutProps> = ({
  fileCount,
  onLeave,
  leaveLabel,
  leaveDisabled,
  actions,
  children,
}) => {
  const native = isNativeShell();
  return (
    <div className="ls-imp-page">
      <div
        className="ls-native-chrome flex items-center justify-between flex-shrink-0"
        style={{
          height: 'var(--ls-topbar-h)',
          padding: `0 14px 0 ${native ? NATIVE_LEFT_INSET : 14}px`,
          background: 'var(--ls-panel)',
          borderBottom: '1px solid var(--ls-border)',
        }}
      >
        <div
          className="flex items-center min-w-0"
          style={{ gap: 6, fontSize: 13, fontWeight: 500 }}
        >
          <span style={{ color: 'var(--ls-text-3)' }}>LogSonic</span>
          <span style={{ color: 'var(--ls-text-4)', margin: '0 6px' }}>/</span>
          <span style={{ color: 'var(--ls-text)' }}>Import</span>
          {fileCount > 0 && (
            <span
              className="ls-imp-mono"
              style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--ls-text-3)' }}
            >
              · {fileCount} file{fileCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center" style={{ gap: 12 }}>
          <span
            className="ls-imp-mono ls-imp-mode"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--ls-text-4)',
            }}
          >
            {native ? 'native path mode' : 'browser upload'}
          </span>
          <button
            type="button"
            onClick={onLeave}
            disabled={leaveDisabled}
            className="ls-imp-btn ls-imp-btn--ghost"
            style={{ height: 28, padding: '0 10px', fontWeight: 500, fontSize: 12 }}
            aria-label={leaveLabel}
          >
            <ArrowLeft size={13} />
            <span>{leaveLabel}</span>
          </button>
          {actions}
        </div>
      </div>
      <div className="ls-imp-body">{children}</div>
    </div>
  );
};

export default ImportLayout;
