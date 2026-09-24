# macos-b1 — Visible nativeness (titlebar, native contract, appearance-follow)

**Horizon:** Now (v1.7) · **Size:** M · **Priority:** P1
**TBD.md ref:** §11 Bundle 1 (incl. item 4, window memory). Shell + CSS only — no Go backend changes.
**Depends on:** now-01 (after it, the web app already uses the system font stack, so no font switching is needed here).
**Read `specs/README.md` first.**

## Goal

Three changes that convert "web page in a Mac window" into "Mac app": (1) unified transparent titlebar with traffic lights inset over the app's own header; (2) a native-detection contract so the frontend knows it's inside the shell; (3) the window follows macOS light/dark appearance with no white flash on launch.

## Current-state anchors (Swift shell)

- `backend/macos/LogsonicApp.swift` — the whole shell. Window creation is in the app-delegate/setup section (find `NSWindow(` / `styleMask`). Existing pieces to preserve untouched: child-process lifecycle (SIGINT on quit), `NativeFileSchemeHandler` (dock drag-drop), `blobDownloadHookJS` (download interception, lines 40–70), console window, `StatusPill` (line ~120), brand color `#6d5dfc` (line 31).
- `backend/macos/ListeningURL.swift` — child stdout URL parsing (untouched).
- Build: `backend/scripts/app-macos.sh` — swiftc per-arch + lipo; header comment in LogsonicApp.swift lines 18–23 shows the exact invocation. Target is macOS 11+ — every API used must be available on macOS 11.
- Frontend header: `frontend/src/components/Home/Header.tsx` (top chrome), shell root styles in `frontend/src/index.css`, theme store `frontend/src/stores/useThemeStore.ts` (read it to learn the current theme model — likely 'light'|'dark'; this task adds 'auto').

## Design decisions (made)

- **Titlebar:** `window.titlebarAppearsTransparent = true`, `styleMask.insert(.fullSizeContentView)`, `window.titleVisibility = .hidden`. Traffic lights stay at default position (no `NSTitlebarAccessoryViewController` tricks in v1). The web header pads itself left by **78 px** when native so content clears the buttons.
- **Window drag:** WKWebView swallows mouse events, so CSS alone can't make a drag region. Implement the standard WKWebView pattern: subclass or override in the web view's containing view — on `mouseDown` in the top **52 px** strip (header height), call `window.performDrag(with: event)` **unless** the DOM element under the cursor is interactive. Determine interactivity by an injected hit-test: elements (or ancestors) carrying `data-native-drag="false"` are interactive; the header root carries `data-native-drag="true"`. Synchronously querying the DOM on mouseDown is done via `evaluateJavaScript` being async — so instead use the simpler reliable rule: **drag strip = top 52 px minus any element that is a button/input/a/select** — implement by injecting a tiny script that, on `mousedown` within the strip on a non-interactive target, posts `logsonicDrag` to a message handler; the Swift handler then calls `performDrag`. The native `mouseDown` never needs to hit-test the DOM itself. Double-click on the drag strip = zoom (standard macOS), implement in the same handler path.
- **Native contract:** inject at `.atDocumentStart` (WKUserScript, all frames false):
  ```js
  window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion: '<CFBundleShortVersionString>', token: undefined // filled by now-09 phase 2 };
  ```
  Frontend, very early (in `src/main.tsx` before render): if present, add class `is-native-macos` to `document.documentElement`.
- **Frontend CSS keyed off `.is-native-macos`:** header gets `padding-left: 78px` and `height: 52px` alignment; hide the "open external"/browser-redundant buttons in `Header.tsx` (the shell's View menu already offers Open in Browser); disable text selection + default cursor on chrome elements (`user-select: none` on header/rail — NOT on log content).
- **Appearance-follow:** theme model becomes `'auto' | 'light' | 'dark'` with `auto` as default **in the native shell only** (browser default unchanged). Shell observes `NSApp.effectiveAppearance` via KVO and posts `window.__logsonicSetSystemAppearance('dark'|'light')` on change + once at load; `useThemeStore` in `auto` mode mirrors it. Persist the user's explicit choice as today.
- **Window memory (added rev 2):** `window.setFrameAutosaveName("main")` right after the window is created in `buildWindow()` (one line; AppKit persists frame + screen). Also persist the *server-log* window frame under `"serverLog"`. Test: move/resize, quit, relaunch → same frame; a display that disappeared → AppKit falls back to visible bounds (no test needed, note it).
- **No white flash:** set the WKWebView non-opaque (`setValue(false, forKey: "drawsBackground")` — the long-standing supported-in-practice key on WKWebView; macOS 12+ also has `underPageBackgroundColor`, guard with `#available`) and set the window `backgroundColor` to the app background token color for the current appearance (light `#fafaf9` / dark match the web `--ls-bg` dark value — read the actual dark value from `index.css` and hard-code the pair in Swift with a comment naming the token).

## Step-by-step

1. **Swift:** window style changes; `setFrameAutosaveName` for both windows; drag-strip message handler (`logsonicDrag` → `performDrag`, double-click → `window.zoom(nil)`); `WKUserScript` injecting `__LOGSONIC_NATIVE__` (+ the drag-strip mousedown forwarder JS); appearance KVO → `evaluateJavaScript`; background-color/no-flash setup. Keep all additions in clearly-marked sections of `LogsonicApp.swift`; update its header comment.
2. **Frontend:** `main.tsx` native-class bootstrap; `useThemeStore` gains `'auto'` + a `setSystemAppearance` entry point assigned to `window.__logsonicSetSystemAppearance`; `index.css` `.is-native-macos` block; `Header.tsx` hides browser-redundant controls and adds the drag-strip data attributes (mark every interactive child appropriately if the forwarder JS needs it).
3. **Settings/theme toggle:** the existing Sun/Moon toggle becomes a three-state cycle (auto → light → dark) when native; label the auto state (e.g. half-sun icon or "Auto" tooltip). In browser it stays two-state.
4. Rebuild: `bash backend/scripts/app-macos.sh` (or the swiftc lines from the file header) — build must stay warning-clean for both arches on macOS 11 target.

## Test cases

**Swift unit (extend `ListeningURLTests.swift` pattern — add `AppearanceTests.swift` only if logic is extractable; most of this bundle is UI and lands in manual tests):** the drag-strip decision function (given target-is-interactive flag + y-coordinate → drag/no-drag) should be a pure Swift function with 4 unit cases.

**Frontend unit (vitest):**

| # | Case | Pass criterion |
|---|------|----------------|
| N1 | `__LOGSONIC_NATIVE__` present at bootstrap | `<html>` gets `is-native-macos` |
| N2 | absent | class absent; theme default unchanged |
| N3 | store in `auto`, `setSystemAppearance('dark')` | effective theme dark; DOM theme attribute updates |
| N4 | store in explicit `light`, `setSystemAppearance('dark')` | stays light |

**Manual (the real test suite for this bundle):**

| # | Check |
|---|------|
| M1 | Launch app in dark mode: no white flash at any point |
| M2 | Traffic lights overlay the app header; no double-height title area; buttons work (close/min/zoom) |
| M3 | Drag window by header background; CANNOT drag by clicking header buttons/inputs; double-click header zooms |
| M4 | System Settings → toggle appearance while app runs → app follows live (auto mode) |
| M5 | In-app explicit theme choice overrides system and persists across relaunch |
| M6 | Browser mode (`View → Open in Browser`): none of the native CSS applies; theme toggle is two-state |
| M7 | Fullscreen (green button) and split-view behave; header still usable |
| M8 | Dock drag-drop import still works; downloads still land natively; quit still SIGINTs the server (regression sweep of existing shell features) |
| M9 | `logsonic -open` CLI browser path unaffected |
| M10 | Move + resize the window, quit, relaunch → same frame and screen; same for the Server Log window |

## Acceptance criteria

- [ ] All manual checks M1–M9 pass on both an Apple-silicon and (if available) Intel build; otherwise M1–M9 on arm64 + successful x86_64 compile.
- [ ] Frontend unit tests N1–N4 green; vitest + eslint green.
- [ ] No Go changes; embedded UI unchanged in browser contexts.
- [ ] `LogsonicApp.swift` header comment updated to describe the new behaviors.

## Out of scope

Menus/shortcuts (macos-b2), NSOpenPanel, status item, notifications (macos-b3), Sparkle.
