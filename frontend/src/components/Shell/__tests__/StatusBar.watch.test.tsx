import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from '../StatusBar';

import { useWatchesStore } from '@/stores/useWatchesStore';

vi.mock('@/hooks/useBackendStatus', () => ({ useBackendStatus: () => ({ isConnected: true }) }));

beforeEach(() => {
  useWatchesStore.setState({
    watches: [],
    loaded: true,
    isLoading: false,
    error: null,
    fetchWatches: vi.fn().mockResolvedValue(undefined),
  });
});

describe('StatusBar watch indicator', () => {
  it('is absent with no active watch and links to the settings page when watching', () => {
    const { rerender } = render(
      <MemoryRouter>
        <StatusBar />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('watch-indicator')).toBeNull();
    expect(useWatchesStore.getState().fetchWatches).toHaveBeenCalledTimes(1);
    useWatchesStore.setState({
      watches: [
        { id: 'a', dir: '/x/logs', glob: '*.log', paused: false, created_at: '', files: [] },
        { id: 'b', dir: '/y/logs', glob: '*.log', paused: true, created_at: '', files: [] },
      ],
    });
    rerender(
      <MemoryRouter>
        <StatusBar />
      </MemoryRouter>
    );
    const link = screen.getByTestId('watch-indicator');
    expect(link.textContent).toBe('Watching 1 folder');
    expect(link.getAttribute('href')).toBe('/settings/watches');
    expect(link.getAttribute('title')).toBe('/x/logs');
  });
});
