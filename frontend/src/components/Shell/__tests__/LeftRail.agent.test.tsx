import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { LeftRail } from '../LeftRail';

import { useAgentStore } from '@/stores/useAgentStore';

beforeEach(() => useAgentStore.setState({ panelOpen: false }));

describe('LeftRail Agent entry', () => {
  it('toggles the agent dock on the log view', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LeftRail />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(useAgentStore.getState().panelOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(useAgentStore.getState().panelOpen).toBe(false);
  });

  it('returns to the log view with the dock open from another page', () => {
    render(
      <MemoryRouter initialEntries={['/import']}>
        <LeftRail />
        <Routes>
          <Route path="/" element={<div>Log view</div>} />
          <Route path="/import" element={<div>Import page</div>} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('Log view')).toBeTruthy();
    expect(useAgentStore.getState().panelOpen).toBe(true);
  });
});
