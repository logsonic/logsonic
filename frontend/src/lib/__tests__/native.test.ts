import { afterEach, describe, expect, it } from 'vitest';

import { applyNativeBootstrapClass, isNativeShell } from '../native';

afterEach(() => {
  delete window.__LOGSONIC_NATIVE__;
});

describe('isNativeShell', () => {
  it('is false when __LOGSONIC_NATIVE__ is absent (browser)', () => {
    expect(isNativeShell()).toBe(false);
  });

  it('is true when __LOGSONIC_NATIVE__ is present (native shell)', () => {
    window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion: '1.0.0' };
    expect(isNativeShell()).toBe(true);
  });
});

describe('applyNativeBootstrapClass', () => {
  // N1
  it('adds is-native-macos when __LOGSONIC_NATIVE__ is present at bootstrap', () => {
    window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion: '1.0.0' };
    const root = document.createElement('html');

    applyNativeBootstrapClass(root);

    expect(root.classList.contains('is-native-macos')).toBe(true);
  });

  // N2
  it('leaves the class absent when __LOGSONIC_NATIVE__ is absent', () => {
    const root = document.createElement('html');

    applyNativeBootstrapClass(root);

    expect(root.classList.contains('is-native-macos')).toBe(false);
  });
});
