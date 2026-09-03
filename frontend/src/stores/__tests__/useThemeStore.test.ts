import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useThemeStore } from '../useThemeStore';

beforeEach(() => {
  localStorage.removeItem('logsonic-theme');
  // The store is a module-level singleton; reset its non-persisted fields
  // explicitly so each test starts from a known state regardless of order.
  useThemeStore.setState({ theme: 'light', systemAppearance: 'light', effectiveTheme: 'light' });
});

afterEach(() => {
  delete window.__LOGSONIC_NATIVE__;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
});

describe('useThemeStore', () => {
  it('setTheme applies the explicit theme to the DOM', () => {
    useThemeStore.getState().setTheme('dark');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(useThemeStore.getState().effectiveTheme).toBe('dark');
  });

  it('setTheme("auto") resolves against the current systemAppearance, not the literal string', () => {
    useThemeStore.setState({ systemAppearance: 'dark' });

    useThemeStore.getState().setTheme('auto');

    // The bug this guards against: writing data-theme="auto" directly,
    // which matches no CSS selector.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('auto');
  });

  // N3
  it('in auto mode, setSystemAppearance changes the effective theme and the DOM', () => {
    useThemeStore.getState().setTheme('auto');

    useThemeStore.getState().setSystemAppearance('dark');

    expect(useThemeStore.getState().effectiveTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  // N4
  it('with an explicit theme, setSystemAppearance does not change it', () => {
    useThemeStore.getState().setTheme('light');

    useThemeStore.getState().setSystemAppearance('dark');

    expect(useThemeStore.getState().theme).toBe('light');
    expect(useThemeStore.getState().effectiveTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme is a plain two-state light/dark flip off the effective theme', () => {
    useThemeStore.getState().setTheme('light');

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('cycleTheme walks auto -> light -> dark -> auto', () => {
    useThemeStore.getState().setTheme('auto');

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe('light');

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');

    useThemeStore.getState().cycleTheme();
    expect(useThemeStore.getState().theme).toBe('auto');
  });

  it('notifies the native shell of the effective theme on every change', () => {
    const calls: string[] = [];
    window.__logsonicNotifyTheme = (effective) => calls.push(effective);

    useThemeStore.getState().setTheme('dark');
    useThemeStore.getState().setTheme('auto');
    useThemeStore.getState().setSystemAppearance('dark');

    expect(calls).toEqual(['dark', 'light', 'dark']);
    delete window.__logsonicNotifyTheme;
  });

  it('wires window.__logsonicSetSystemAppearance to the store', () => {
    useThemeStore.getState().setTheme('auto');

    window.__logsonicSetSystemAppearance?.('dark');

    expect(useThemeStore.getState().effectiveTheme).toBe('dark');
  });
});
