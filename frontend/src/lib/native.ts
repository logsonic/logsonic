// Shared native-macOS-shell contract (macos-b1). LogsonicApp.swift injects
// window.__LOGSONIC_NATIVE__ via a WKUserScript at document start; it is
// always undefined in the browser.
export type NativeAppearance = 'light' | 'dark';

declare global {
  interface Window {
    __LOGSONIC_NATIVE__?: {
      platform: 'macos';
      shellVersion: string;
      token?: string; // filled by now-09 phase 2
    };
    // Shell -> page: called when NSApp.effectiveAppearance changes (and
    // once at load) so a theme in 'auto' mode can follow the OS.
    __logsonicSetSystemAppearance?: (appearance: NativeAppearance) => void;
    // Page -> shell: called whenever the effective (resolved) theme
    // changes, so the native window background can repaint before the
    // next resize instead of flashing the previous theme's color.
    __logsonicNotifyTheme?: (effective: NativeAppearance) => void;
  }
}

export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__LOGSONIC_NATIVE__);
}

// Marks <html> so CSS/components can key off native-only behavior (unified
// titlebar padding, drag regions, hiding browser-redundant chrome) without
// re-checking window.__LOGSONIC_NATIVE__ everywhere.
export function applyNativeBootstrapClass(root: HTMLElement = document.documentElement): void {
  root.classList.toggle('is-native-macos', isNativeShell());
}
