import { isHeaderPatternMissing } from './multilinePresets';

import type { ImportFile } from '../types';

export interface ImportGate {
  disabled: boolean;
  // Short reason rendered under the Import button when disabled.
  reason: string | null;
}

// Whether a file's timestamp verdict still needs the user's confirmation.
export function fileNeedsTimestampConfirmation(f: ImportFile): boolean {
  return (
    !!f.timestampInference &&
    (f.timestampInference.status === 'ambiguous' || f.timestampInference.status === 'missing') &&
    !f.timestampConfirmed
  );
}

// The same gates the wizard's Next button enforced on its pattern step,
// in the order the user can act on them, each with the reason the button
// shows. Empty file list is handled by the caller (no button at all).
export function importGate(files: ImportFile[], isUploading: boolean): ImportGate {
  if (isUploading) return { disabled: true, reason: null };
  const detecting = files.filter(
    (f) => f.detectionStatus === 'detecting' || f.detectionStatus === 'pending'
  ).length;
  if (detecting > 0) {
    return {
      disabled: true,
      reason: `Detecting patterns — ${detecting} file${detecting === 1 ? '' : 's'} pending`,
    };
  }
  const badRegex = files.filter((f) => isHeaderPatternMissing(f.sessionOptions.multiline));
  if (badRegex.length > 0) {
    return {
      disabled: true,
      reason:
        badRegex.length === 1
          ? `Fix the multiline regex on ${badRegex[0].fileName} before importing`
          : `Fix the multiline regex on ${badRegex.length} files before importing`,
    };
  }
  const missing = files.filter((f) => !f.selectedPattern).length;
  if (missing > 0) {
    return { disabled: true, reason: `All files need a pattern — ${missing} pending` };
  }
  const unconfirmed = files.filter(fileNeedsTimestampConfirmation);
  if (unconfirmed.length > 0) {
    const noneFound = unconfirmed.some((f) => f.timestampInference?.status === 'missing');
    return {
      disabled: true,
      reason: noneFound
        ? 'Confirm the missing timestamp before importing'
        : 'Resolve ambiguous timestamps before importing',
    };
  }
  return { disabled: false, reason: null };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function matchColor(rate: number): string {
  if (rate >= 95) return 'var(--ls-ok)';
  if (rate >= 80) return 'var(--ls-warn)';
  return 'var(--ls-err)';
}
