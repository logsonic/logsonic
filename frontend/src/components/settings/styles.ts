/** The settings pages' card-and-row idiom (About, Storage, Watched folders). */
export const settingsCard: React.CSSProperties = {
  background: 'var(--ls-panel)',
  border: '1px solid var(--ls-border)',
  borderRadius: 'var(--ls-radius-lg)',
  boxShadow: 'var(--ls-shadow-sm)',
  padding: '6px 16px',
  marginBottom: 14,
  // A long path in a row must truncate inside the card, never widen it
  // past the settings column (which clips the other cards' controls).
  overflow: 'hidden',
  minWidth: 0,
};

export const settingsRow = (first: boolean): React.CSSProperties => ({
  gap: 16,
  padding: '10px 0',
  borderTop: first ? 'none' : '1px solid var(--ls-border-subtle)',
});

export const settingsLabel: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--ls-text)',
  flexShrink: 0,
};

export const settingsNote: React.CSSProperties = { fontSize: 12, color: 'var(--ls-text-2)' };
