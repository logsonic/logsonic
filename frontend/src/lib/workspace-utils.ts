// Keep saved column widths within the backend workspace schema's bounds.
export const MAX_WORKSPACE_COLUMN_WIDTH = 2000;

export const normalizeWorkspaceColumnWidths = (
  widths?: Record<string, unknown> | null,
): Record<string, number> => {
  const normalized: Record<string, number> = {};

  for (const [column, width] of Object.entries(widths ?? {})) {
    const numericWidth = typeof width === 'number' ? width : Number(width);
    if (!Number.isFinite(numericWidth)) continue;

    normalized[column] = Math.min(
      MAX_WORKSPACE_COLUMN_WIDTH,
      Math.max(0, Math.round(numericWidth)),
    );
  }

  return normalized;
};
