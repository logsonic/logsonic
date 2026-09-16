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
    // The real system appearance at the moment the page started loading,
    // injected alongside __LOGSONIC_NATIVE__ (same document-start script,
    // so it's set before any module code runs). Swift only calls
    // __logsonicSetSystemAppearance below on a *change* -- without this,
    // a store default has to guess at mount time, and guessing 'light'
    // shows the wrong theme under 'auto' when the OS is already dark at
    // launch (found live, 2026-09-03).
    __LOGSONIC_INITIAL_APPEARANCE__?: NativeAppearance;
    // Shell -> page: called when NSApp.effectiveAppearance changes after
    // load, so a theme in 'auto' mode can keep following the OS.
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

/**
 * Asks the macOS shell to reveal the index folder in Finder. Returns false
 * when there is no shell to ask (browser mode, other platforms), in which
 * case the caller shows the path with a copy button instead. The handler
 * ("logsonicReveal", LogsonicApp.swift) is registered only by the shell,
 * and only the app's own page can post to it.
 */
export function revealStoragePath(): boolean {
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { logsonicReveal?: { postMessage: (m: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.logsonicReveal;
  if (!handler) return false;
  handler.postMessage({});
  return true;
}
