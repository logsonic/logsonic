import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StorageSettings from '../Storage';

import type { StorageResponse } from '@/lib/api-types';

import { ApiError } from '@/lib/api-client';

const api = vi.hoisted(() => ({
  getStorage: vi.fn(),
  updateStorage: vi.fn(),
  deleteStorageDay: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const native = vi.hoisted(() => ({
  isNativeShell: vi.fn(() => false),
  revealStoragePath: vi.fn(() => false),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, ...api };
});
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/stores/useSourcesStore', () => ({ refreshAfterMutation: refresh }));
vi.mock('@/lib/native', () => native);

const storage = (over: Partial<StorageResponse> = {}): StorageResponse => ({
  status: 'success',
  retention_days: 30,
  retention_source: 'flag',
  retention_default: 30,
  days: [
    { date: '2026-03-01', rows: 2000, bytes: 265488 },
    { date: '2026-03-02', rows: 88, bytes: 12000 },
  ],
  total_bytes: 277488,
  path: '/data/logsonic',
  config_path: '/data/logsonic/config.json',
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <StorageSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  native.isNativeShell.mockReturnValue(false);
  api.getStorage.mockResolvedValue(storage());
});

describe('StorageSettings', () => {
  it('shows retention with its source, the per-day table with sizes, and the paths', async () => {
    renderPage();
    expect(await screen.findByText(/From the -retention-days flag/)).toBeTruthy();
    expect((screen.getByLabelText('Retention days') as HTMLInputElement).value).toBe('30');
    expect(screen.getAllByTestId('storage-day')).toHaveLength(2);
    expect(screen.getByText('2,000 rows')).toBeTruthy();
    expect(screen.getByText(/2 days, 270.98 KB|2 days, 271/)).toBeTruthy();
    expect(screen.getByText('/data/logsonic')).toBeTruthy();
    expect(screen.getByText('/data/logsonic/config.json')).toBeTruthy();
    expect(screen.queryByText('Reveal in Finder')).toBeNull();
  });

  it('Save is disabled when unchanged or invalid, saves a new value, and refreshes the app', async () => {
    api.updateStorage.mockResolvedValueOnce(
      storage({ retention_days: 7, retention_source: 'config' })
    );
    renderPage();
    const input = (await screen.findByLabelText('Retention days')) as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // unchanged

    fireEvent.change(input, { target: { value: '4000' } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/whole number from 0 to 3650/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '7' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.updateStorage).toHaveBeenCalledWith({ retention_days: 7 }));
    expect(await screen.findByText(/Set here, overriding the -retention-days 30/)).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Retention set to 7 days' })
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('clears the override with null and explains what applies next', async () => {
    api.getStorage.mockResolvedValue(storage({ retention_days: 7, retention_source: 'config' }));
    api.updateStorage.mockResolvedValueOnce(storage());
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Clear and use 30 days from the flag/ })
    );
    await waitFor(() => expect(api.updateStorage).toHaveBeenCalledWith({ retention_days: null }));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Retention override cleared' })
    );
  });

  it('zero reads as kept forever and 0 with nothing set is saveable', async () => {
    api.getStorage.mockResolvedValue(
      storage({ retention_days: 0, retention_source: 'none', retention_default: 0 })
    );
    renderPage();
    expect(
      await screen.findByText(/Nothing set: logs are kept until you delete them/)
    ).toBeTruthy();
    // With nothing set, saving "0" explicitly is a real change (it pins the override).
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    api.updateStorage.mockResolvedValueOnce(
      storage({ retention_days: 0, retention_source: 'config', retention_default: 0 })
    );
    fireEvent.click(save);
    await waitFor(() => expect(api.updateStorage).toHaveBeenCalledWith({ retention_days: 0 }));
    expect(await screen.findByText(/Kept forever\. Set here\./)).toBeTruthy();
    expect(save.disabled).toBe(true); // pinned: now unchanged
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Retention off — logs are kept forever' })
    );
    // Non-digit input never validates.
    fireEvent.change(screen.getByLabelText('Retention days'), { target: { value: '1e3' } });
    expect(save.disabled).toBe(true);
  });

  it('delete-day asks for confirmation naming rows and size, then deletes, reloads and refreshes', async () => {
    api.deleteStorageDay.mockResolvedValueOnce({
      status: 'success',
      date: '2026-03-02',
      rows_deleted: 88,
    });
    api.getStorage
      .mockResolvedValueOnce(storage())
      .mockResolvedValueOnce(
        storage({ days: [{ date: '2026-03-01', rows: 2000, bytes: 265488 }] })
      );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2026-03-02' }));
    expect(await screen.findByText('Delete 2026-03-02?')).toBeTruthy();
    expect(screen.getByText(/Removes 88 rows \(11.72 KB\) from every source/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete day' }));
    await waitFor(() => expect(api.deleteStorageDay).toHaveBeenCalledWith('2026-03-02'));
    await waitFor(() => expect(screen.getAllByTestId('storage-day')).toHaveLength(1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deleted 2026-03-02' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('maps a 409 on delete-day to user copy', async () => {
    api.deleteStorageDay.mockRejectedValueOnce(
      new ApiError('Day is in use', 409, 'DAY_IN_USE', 'a.log: a live tail is writing…')
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2026-03-02' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete day' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Could not delete 2026-03-02',
          description: expect.stringMatching(/live tail/),
        })
      )
    );
  });

  it('shows Reveal in Finder only in the native shell and posts to it', async () => {
    native.isNativeShell.mockReturnValue(true);
    native.revealStoragePath.mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Reveal in Finder/ }));
    expect(native.revealStoragePath).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('empty store shows the import invitation', async () => {
    api.getStorage.mockResolvedValue(storage({ days: [], total_bytes: 0 }));
    renderPage();
    expect(await screen.findByText(/No logs stored yet/)).toBeTruthy();
  });
});
