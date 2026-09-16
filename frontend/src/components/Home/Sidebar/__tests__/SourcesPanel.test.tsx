import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SourcesPanel } from '../SourcesPanel';

import type { SourceEntry } from '@/lib/api-types';

import { useImportStore } from '@/stores/useImportStore';
import { useSourcesStore } from '@/stores/useSourcesStore';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const entry = (name: string, extra: Partial<SourceEntry> = {}): SourceEntry => ({
  name,
  aliases: [],
  origin: { kind: 'file', path: `/logs/${name}` },
  pattern_name: 'APACHE',
  rows: 12345,
  bytes_raw: 1,
  days: ['2026-03-01', '2026-03-02', '2026-03-03'],
  day_rows: { '2026-03-01': 1, '2026-03-02': 1, '2026-03-03': 12343 },
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
  imports: [{ at: '2026-03-01T10:00:00Z', rows: 12345, path: `/logs/${name}` }],
  import_options: { name: 'APACHE', source: name },
  ...extra,
});

const renderPanel = () =>
  render(
    <MemoryRouter>
      <SourcesPanel />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  useImportStore.getState().reset();
  useSourcesStore.setState({
    sources: [
      entry('file.apache.log'),
      entry('upload.log', {
        origin: { kind: 'file' },
        import_options: undefined,
        display_name: 'Uploaded',
      }),
    ],
    isLoading: false,
    loaded: true,
    error: null,
    expanded: null,
    deleting: new Set(),
    reimports: {},
    fetchSources: vi.fn().mockResolvedValue(undefined),
    deleteSource: vi.fn().mockResolvedValue({ rowsDeleted: 12345 }),
    renameSource: vi.fn(),
    reimportSource: vi.fn().mockResolvedValue(undefined),
  });
});

describe('SourcesPanel', () => {
  it('lists sources by display name with row counts and expands to details + actions', () => {
    renderPanel();
    const rows = screen.getAllByTestId('source-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('file.apache.log')).toBeTruthy();
    expect(screen.getByText('Uploaded')).toBeTruthy(); // display name, not upload.log
    expect(screen.getAllByText('12,345 rows')).toHaveLength(2);

    fireEvent.click(screen.getByText('file.apache.log'));
    expect(screen.getByText(/3 days, 2026-03-01 to 2026-03-03/)).toBeTruthy();
    expect(screen.getByText('From file.apache.log').getAttribute('title')).toBe(
      '/logs/file.apache.log'
    );
    expect(screen.getByText('APACHE')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-import' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
  });

  it('shows the stored name for a renamed source and disables re-import for a browser upload', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Uploaded'));
    expect(screen.getByText('upload.log')).toBeTruthy();
    expect(screen.getByText('Uploaded from the browser')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Re-import' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('delete asks for confirmation naming the rows and days, then calls the store and toasts', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('file.apache.log'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete file.apache.log?')).toBeTruthy();
    expect(screen.getByText(/Removes 12,345 rows from 3 days/)).toBeTruthy();
    expect(screen.getByText(/This can't be undone/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete source' }));
    await waitFor(() =>
      expect(useSourcesStore.getState().deleteSource).toHaveBeenCalledWith('file.apache.log')
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Deleted file.apache.log' })
      )
    );
  });

  it('cancel leaves the source alone', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('file.apache.log'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useSourcesStore.getState().deleteSource).not.toHaveBeenCalled();
  });

  it('blocks delete and re-import while the wizard is importing', () => {
    useImportStore.setState({ isUploading: true });
    renderPanel();
    fireEvent.click(screen.getByText('file.apache.log'));
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByRole('button', { name: 'Re-import' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('re-import confirm names the file and pattern; a running re-import shows its row', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('file.apache.log'));
    fireEvent.click(screen.getByRole('button', { name: 'Re-import' }));
    expect(await screen.findByText('Re-import file.apache.log?')).toBeTruthy();
    expect(screen.getByText(/Deletes its 12,345 rows/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-import', hidden: false }));
    await waitFor(() =>
      expect(useSourcesStore.getState().reimportSource).toHaveBeenCalledWith('file.apache.log')
    );

    // The entry stays (at zero rows) while the job runs: its own row shows the state.
    useSourcesStore.setState({
      sources: [entry('file.apache.log', { rows: 0 })],
      reimports: {
        'file.apache.log': {
          name: 'file.apache.log',
          jobId: 'j',
          path: '/logs/file.apache.log',
          rowsStored: 40,
          state: 'running',
        },
      },
    });
    expect(await screen.findByTestId('source-reimporting')).toBeTruthy();
    expect(screen.getByText(/re-importing, 40 rows/)).toBeTruthy();
    expect(screen.getAllByTestId('source-row')).toHaveLength(1); // the real row, no synthetic duplicate
    // Fallback: the entry absent → a synthetic row instead.
    useSourcesStore.setState({ sources: [] });
    expect(await screen.findByTestId('source-reimporting')).toBeTruthy();
    expect(screen.getByText(/re-importing, 40 rows/)).toBeTruthy();
  });

  it('rename dialog saves through the store and surfaces a name collision', async () => {
    const renameSource = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('taken'), { name: 'ApiError', code: 'SOURCE_NAME_TAKEN' })
      );
    useSourcesStore.setState({ renameSource });
    renderPanel();
    fireEvent.click(screen.getByText('file.apache.log'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = await screen.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(renameSource).toHaveBeenCalledWith('file.apache.log', 'prod'));
    // The rejection was a plain Error carrying a code, not an ApiError, so
    // the panel falls back to its message.
    expect(await screen.findByText('taken')).toBeTruthy();
  });

  it('refetches on every mount, not just the first', () => {
    renderPanel();
    expect(useSourcesStore.getState().fetchSources).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state with a link to import', () => {
    useSourcesStore.setState({ sources: [] });
    renderPanel();
    expect(screen.getByText(/No sources yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import a log file' }).getAttribute('href')).toBe(
      '/import'
    );
  });
});
