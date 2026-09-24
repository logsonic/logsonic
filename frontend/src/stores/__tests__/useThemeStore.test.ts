import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useThemeStore } from '../useThemeStore';

beforeEach(() => {
  localStorage.removeItem('logsonic-theme');
  // The store is a module-level singleton; reset its non-persisted fields
  // explicitly so each test starts from a known state regardless of order.
  useThemeStore.setState({ theme: 'light', systemAppearance: 'light', effectiveTheme: 'light' });
});

afterEach(() => {
  delete window.__LOGSONIC_NATIVE__;
  delete window.__LOGSONIC_INITIAL_APPEARANCE__;
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
    (window as unknown as { webkit: { messageHandlers: { logsonicTheme: { postMessage: (m: unknown) => void } } } }).webkit = {
      messageHandlers: { logsonicTheme: { postMessage: (m) => calls.push(m as string) } },
    };

    useThemeStore.getState().setTheme('dark');
    useThemeStore.getState().setTheme('auto');
    useThemeStore.getState().setSystemAppearance('dark');

    expect(calls).toEqual(['dark', 'light', 'dark']);
    delete (window as unknown as { webkit?: unknown }).webkit;
  });

  it('wires window.__logsonicSetSystemAppearance to the store', () => {
    useThemeStore.getState().setTheme('auto');

    window.__logsonicSetSystemAppearance?.('dark');

    expect(useThemeStore.getState().effectiveTheme).toBe('dark');
  });

  // Regression: __logsonicSetSystemAppearance only fires on a later change
  // (see native.ts), so a module that read systemAppearance as a hardcoded
  // 'light' initial value showed the wrong theme under 'auto' on a launch
  // where the OS was already dark. The fix reads
  // window.__LOGSONIC_INITIAL_APPEARANCE__, injected before any module code
  // runs -- this exercises that at actual module-init time via a fresh
  // import, not via setState, since setState can't stand in for what the
  // module computes on load.
  it('in the native shell, resolves auto theme from __LOGSONIC_INITIAL_APPEARANCE__ at module load', async () => {
    // beforeEach's setState() above goes through the persist middleware
    // too, so it just wrote {theme:'light'} back to localStorage -- clear
    // it again or the fresh module below rehydrates that stale value.
    localStorage.removeItem('logsonic-theme');
    vi.resetModules();
    window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion: '0.0.0' };
    window.__LOGSONIC_INITIAL_APPEARANCE__ = 'dark';

    const { useThemeStore: freshStore } = await import('../useThemeStore');

    expect(freshStore.getState().theme).toBe('auto');
    expect(freshStore.getState().systemAppearance).toBe('dark');
    expect(freshStore.getState().effectiveTheme).toBe('dark');
    // The symptom the user actually saw: not just store state, but the DOM
    // still painted light on a dark-launch until the OS appearance changed.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
