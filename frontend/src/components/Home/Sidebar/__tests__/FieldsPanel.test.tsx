import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FieldsPanel } from '../FieldsPanel';

import { useFacetStore } from '@/stores/useFacetStore';

vi.mock('@/hooks/useSearchLogs', () => ({
  refreshSearchMetadata: vi.fn().mockResolvedValue(undefined),
  searchFingerprint: () => 'fp',
}));

beforeEach(() => {
  useFacetStore.setState({
    facets: {
      computed_over: 12,
      sampled: false,
      fields: [
        {
          name: 'level',
          distinct: 2,
          high_cardinality: false,
          values: [{ value: 'INFO', count: 10, truncated: false }],
        },
        {
          name: '_src',
          distinct: 3,
          high_cardinality: false,
          values: [
            { value: 'file.a.log', count: 50000, truncated: false },
            { value: 'file.b.log', count: 7, truncated: false },
          ],
        },
      ],
    },
    fingerprint: 'fp',
    panelOpen: true,
    isLoading: false,
    error: null,
    expandedFields: new Set(),
    showAllFields: new Set(),
  });
});

describe('FieldsPanel — _src is corpus-wide (spec now-02 line 24, live since now-10)', () => {
  it('labels the _src row as whole-index and explains it when expanded; other fields keep their distinct count', () => {
    render(<FieldsPanel />);
    expect(screen.getByText('3 in the whole index')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy(); // level's distinct count, unchanged
    expect(screen.queryByText(/not just this search/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /_src/ }));
    expect(screen.getByText(/Every source with its total rows, not just this search/)).toBeTruthy();
    // A corpus-wide count above the window's 12 rows renders as-is.
    expect(screen.getByText('50,000')).toBeTruthy();
  });
});
