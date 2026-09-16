import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { NativeAppearance } from '@/lib/native';

import { isNativeShell } from '@/lib/native';

// 'auto' only makes sense inside the native macOS shell, which posts system
// appearance changes via setSystemAppearance(). The browser has no such
// signal, so its default stays 'light' (see defaultTheme() below).
export type Theme = 'auto' | 'light' | 'dark';
type EffectiveTheme = NativeAppearance;

interface ThemeState {
  // The user's persisted intent -- never derive DOM state from this
  // directly when it's 'auto'; use `effectiveTheme` instead.
  theme: Theme;
  // What the OS reports right now (native shell only; meaningless in the
  // browser). Not persisted -- the shell re-posts it on every launch.
  systemAppearance: EffectiveTheme;
  effectiveTheme: EffectiveTheme;
  setTheme: (theme: Theme) => void;
  // Browser two-state toggle (light <-> dark) -- 'auto' isn't reachable
  // this way since the browser never offers it.
  toggleTheme: () => void;
  // Native three-state cycle (auto -> light -> dark -> auto), per
  // macos-b1's step 3.
  cycleTheme: () => void;
  setSystemAppearance: (appearance: EffectiveTheme) => void;
}

// Browser default is unchanged ('light'); the native shell defaults to
// following the system, matching macos-b1's "visible nativeness" goal.
function defaultTheme(): Theme {
  return isNativeShell() ? 'auto' : 'light';
}

// The real system appearance at launch, from the document-start injection
// (see native.ts) -- NOT from __logsonicSetSystemAppearance, which only
// fires on a later *change*. Falling back to 'light' only ever matters in
// the browser, where 'auto' isn't reachable and this value is unused.
function initialSystemAppearance(): EffectiveTheme {
  return (typeof window !== 'undefined' && window.__LOGSONIC_INITIAL_APPEARANCE__) || 'light';
}

function resolveEffective(theme: Theme, systemAppearance: EffectiveTheme): EffectiveTheme {
  return theme === 'auto' ? systemAppearance : theme;
}

// Applies the DOM side effects (data-theme attribute + .dark class that the
// [data-theme="dark"] / .dark CSS bridges both key off) and notifies the
// native shell so it can repaint the window background before the next
// resize -- never call with a Theme, only ever with the resolved value.
function applyEffectiveTheme(effective: EffectiveTheme) {
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.classList.toggle('dark', effective === 'dark');
  window.__logsonicNotifyTheme?.(effective);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: defaultTheme(),
      systemAppearance: initialSystemAppearance(),
      effectiveTheme: resolveEffective(defaultTheme(), initialSystemAppearance()),
      setTheme: (theme) => {
        const effective = resolveEffective(theme, get().systemAppearance);
        applyEffectiveTheme(effective);
        set({ theme, effectiveTheme: effective });
      },
      toggleTheme: () => {
        const next = get().effectiveTheme === 'dark' ? 'light' : 'dark';
        get().setTheme(next);
      },
      cycleTheme: () => {
        const order: Theme[] = ['auto', 'light', 'dark'];
        const next = order[(order.indexOf(get().theme) + 1) % order.length];
        get().setTheme(next);
      },
      setSystemAppearance: (appearance) => {
        const { theme } = get();
        const effective = resolveEffective(theme, appearance);
        // Only touch the DOM if this actually changes what's rendered --
        // an explicit light/dark choice must not flip when the OS does.
        if (effective !== get().effectiveTheme) {
          applyEffectiveTheme(effective);
        }
        set({ systemAppearance: appearance, effectiveTheme: effective });
      },
    }),
    {
      name: 'logsonic-theme',
      // Only the user's intent persists; systemAppearance/effectiveTheme are
      // re-derived every load (the shell re-posts appearance on launch).
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const effective = resolveEffective(state.theme, state.systemAppearance);
          applyEffectiveTheme(effective);
          state.effectiveTheme = effective;
        }
      },
    }
  )
);

// The shell calls this directly (not through React) whenever
// NSApp.effectiveAppearance changes after load -- the load-time value comes
// from initialSystemAppearance() above instead.
if (typeof window !== 'undefined') {
  window.__logsonicSetSystemAppearance = (appearance) => {
    useThemeStore.getState().setSystemAppearance(appearance);
  };
}
