# macos-b2 — Menus, shortcuts, paths-not-bytes, Finder integration

**Horizon:** v1.8 → Next · **Size:** M · **Priority:** P1 (after b1)
**TBD.md ref:** §11 Bundle 2 (revision 2 — re-scoped after verifying what the shell already does). **Depends on:** macos-b1 (native contract), now-06 (actions registry), now-08 (`POST /ingest/file`).
**Read `specs/README.md` first.**

## What already exists (verified 2026-09-01 — do NOT re-implement)

Revision 1 of this spec claimed file-type association and native open panels were missing. They are not:

- `Info.plist` (generated in `scripts/app-macos.sh`) already declares `CFBundleDocumentTypes` for `public.log`, `public.plain-text`, `public.json` with role Viewer / `LSHandlerRank` Alternate → Finder already offers "Open With → Logsonic".
- `application(_:openFile:)` and `application(_:openFiles:)` are implemented and route through `openNativeFiles`.
- `runOpenPanelWith` already presents a native `NSOpenPanel` (multi-select, directories when the input allows) for every HTML `<input type=file>`; `NSSavePanel` handles downloads.
- A basic menu bar exists: App (Hide, Quit), File (Close Window), Edit (Undo/Redo/Cut/Copy/Paste/Select All + Copy All Logs), View (Reload ⌘R, Open in Browser, Copy Server URL, Server Log ⌘L, Reveal Index in Finder).

## Goal (what is actually missing)

1. Menus that drive the **app's actions** (import, export, palette, panels, theme, density, new window, check for updates) through the shared actions registry, with ⌘-shortcuts that work while the webview has focus.
2. **Paths, not bytes:** dropped/opened/picked files reach the server as absolute paths (`now-08`), retiring the 512 MB cap, the whole-file read, and the `["log","txt","json"]` extension guard.
3. Finish file-type association (`.gz`, `.jsonl`, `.ndjson`, `.log.N`), a Services entry, and Open Recent.

## Design decisions (made)

- **Single action bridge.** The frontend exposes `window.__logsonicPerformAction(id, payload?)` (native only) mapping into `lib/actions.ts` (now-06). Menu items call `webView.evaluateJavaScript("__logsonicPerformAction('…')")`. Web → native requests (open panel for a *directory* to watch, reveal in Finder, save diagnostics) go through one `logsonicNative` `WKScriptMessageHandler` with `{op, args}`; keep `logsonicDownload` as is.
- **Menu layout (final):**
  - **LogSonic:** About LogSonic (→ SPA `/settings/about`), Check for Updates… (→ `check-updates` action; `next-11`), Settings… (⌘,), Hide, Quit (existing).
  - **File:** New Window (⌘N — a second `NSWindow` + `WKWebView` on the same server URL; windows share the process, each has its own route/workspace; `windowShouldClose` on a secondary window just closes it), Import… (⌘O → `NSOpenPanel` → paths → `import-paths` action → `now-08` flow), Open Recent (submenu), Export… (⌘E → `export` action), Close Window (⌘W, existing).
  - **Edit:** existing.
  - **View:** Toggle Theme, Density (submenu: Comfortable/Compact/Dense, when `next-08` lands), Histogram ⌘1, Fields ⌘2, Sources ⌘3, Reload ⌘R, Open in Browser, Copy Server URL, Server Log ⌘L, Reveal Index in Finder, Enter Full Screen (standard).
  - **Go:** Command Palette (⌘K), Focus Search (no key — `/` stays a webview listener), Previous/Next Page (⌘←/⌘→), Show Context (`c` documented in the item title, no key equivalent).
  - **Help:** LogSonic Help (docs URL, external browser), MCP Setup (→ `/settings/mcp`), Save Diagnostics… (`now-13`).
- **Shortcut routing:** menu items own their key equivalents (⌘O ⌘E ⌘K ⌘1/2/3 ⌘N ⌘,). Because menu key-equivalents fire before the webview sees keys, the frontend **guards its own ⌘K listener with `is-native-macos`** (no double toggle). Keys without modifiers (`/`, `j/k`, `c`) stay in the webview.
- **Paths, not bytes:** `openNativeFiles(paths)` no longer registers scheme URLs; it posts `window.__logsonicPendingNativeFiles = {paths}` + the existing `logsonic-native-files` event (payload gains `paths`; `urls` kept only in `--browser` mode). Drop the extension guard (the server sniffs). Directories dropped on the Dock → `watch-directory` action (`now-04`). `NativeFileSchemeHandler` and `maxNativeDropBytes` remain only for browser-mode fallback, or are deleted if browser mode can live without dock drops (decision: **delete** — in browser mode, `openNativeFiles` already just reveals the files in Finder).
- **File association completion:** add `LSItemContentTypes` `org.gnu.gnu-zip-archive` (`.gz`), `public.comma-separated-values-text`, and a `UTImportedTypeDeclarations` entry for `.jsonl`/`.ndjson` (`com.logsonic.jsonl`, conforms to `public.plain-text`); `.log.1` style names are plain-text already. Services: `NSServices` entry "Analyze with LogSonic" (`NSSendFileTypes: public.item`) + `NSApp.servicesProvider` calling `openNativeFiles`.
- **Open Recent:** `UserDefaults` key `logsonic.recentImports` (last 10 canonical paths, deduped, most-recent first); rebuilt on menu open; "Clear Menu" standard item. Also mirrored to the SPA palette via `__LOGSONIC_NATIVE__.recentImports` at load.

## Current-state anchors

`LogsonicApp.swift` — `buildMenu()` (~253), `openNativeFiles` (~829), `deliverNativeFiles` (~860), `NativeFileSchemeHandler` (73–117), `runOpenPanelWith` (~705), `applicationShouldHandleReopen` (219), `windowShouldClose` (236). `scripts/app-macos.sh` — the `Info.plist` heredoc (`CFBundleDocumentTypes` block). Frontend: `lib/actions.ts` (now-06), `LogSearch.tsx` ⌘K listener, `components/Import/` native-files consumer (grep `logsonic-native-files`), `pages/settings/About.tsx`.

## Step-by-step

1. Frontend: `__logsonicPerformAction`, registry entries for `import-paths`, `export`, `check-updates`, `focus-search`, `prev-page`, `next-page`, `toggle-histogram/fields/sources`, `set-density`, `watch-directory`; guard ⌘K when native; consume `paths` in the import wizard (now-08).
2. Swift: `MenuBuilder.swift` (new file, added to `app-macos.sh` swiftc lists) building the tree above; `logsonicNative` message handler; New Window support (window registry, per-window delegate); paths-not-bytes; delete the scheme handler.
3. Plist: content types + Services; `servicesProvider`; Open Recent store (pure `RecentImports` type with unit tests).
4. Rebuild + re-sign (plist changes require notarization for distribution; ad-hoc for local validation).

## Test cases

**Frontend unit:** `__logsonicPerformAction('toggle-theme')` flips theme; unknown id → `false`, no throw; ⌘K listener inactive when `is-native-macos`.

**Swift unit:** `RecentImports` — add 12 → keeps 10 newest; dedupe on re-add; clear empties. Menu tree snapshot (titles + key equivalents) as a golden test on the pure builder function.

**Manual matrix:**

| # | Check |
|---|------|
| M1 | Every menu item does its action; every listed ⌘-shortcut works while the webview is focused |
| M2 | ⌘C/⌘V still work in the search input |
| M3 | ⌘K opens the palette exactly once (no double-fire) |
| M4 | File → Import… multi-selects two sample logs → both import via `/ingest/file` with progress (verify in Network/Server Log) |
| M5 | Drop a directory on the Dock → folder-watch config opens with the path |
| M6 | Finder: Open With → Logsonic on a `.gz` and a `.jsonl` → imports |
| M7 | Drag a 2 GB file onto the Dock → import starts within 1 s; no memory spike |
| M8 | Open Recent lists imports; re-import works; Clear Menu clears; persists across relaunch |
| M9 | Services menu shows "Analyze with LogSonic" for a selected file in Finder |
| M10 | ⌘N opens a second window on a different workspace; closing it does not quit; ⌘Q still quits cleanly |
| M11 | Browser mode (`--browser`): no dead UI; dock drops reveal files in Finder as today |

## Acceptance criteria

- [ ] Full manual matrix on arm64; Swift + frontend unit tests green.
- [ ] Menus drive the same actions registry as the palette (PR shows the mapping table).
- [ ] No `logsonicfile://` byte path remains for native imports; 512 MB cap and extension guard gone.
- [ ] Plist changes validated in a notarized build once before release.

## Out of scope

Menu-bar extra + notifications (macos-b3), Sparkle (`next-11` decides policy first), dock badge, Windows/Linux shells.
