# macos-b3 — Ambient presence (menu-bar extra, notifications, dock badge)

**Horizon:** Next · **Size:** M · **Priority:** P1 (lands WITH next-04 watchers)
**TBD.md ref:** §11 Bundle 3, §4 retention thesis. **Depends on:** macos-b1; next-04 (watcher events to surface).
**Read `specs/README.md` first.**

## Goal

LogSonic stays useful when its window is closed: an `NSStatusItem` menu-bar extra shows live-tail/watch status with pause/resume; watcher hits become native notifications; the dock icon badges unseen error counts. This is the retention strategy (TBD §4) in native form.

## Design decisions (made)

- **Event source: one SSE subscription.** The shell subscribes to the existing live-events SSE (`GET /api/v1/live/events`, registered outside the timeout group at `server.go:233`) using `URLSession` streaming — the same events the browser UI consumes (`LiveHelloEvent`, `LiveRowsEvent`, `LiveSourceStatusEvent`, `types.go:125–148`). Watcher-fired alert events (defined in next-04) arrive on the same stream. The shell must NOT poll REST in a loop.
- **Window-close behavior changes:** today closing the window quits (per shell header comment: window-close sends SIGINT). New model: closing the window keeps the app + server running **iff** any tail/watch is active (status item visible); plain Quit (⌘Q) always shuts down. If nothing is active, window-close quits as today. Reopening from Dock/status item restores the window. This is the single riskiest behavior change in the bundle — implement behind the decision function `shouldStayAliveOnWindowClose(activeSources: Int) -> Bool` with unit tests, and mention it in release notes.
- **Status item:** template-style glyph (monochrome waveform); menu shows per-source rows "app.log — 42 rows/s" with per-source Pause/Resume (calls `POST /api/v1/live/subscribers/{id}/pause|resume` — note these act on *subscribers*; the shell maintains its own subscriber where needed, matching the browser semantics from `handlers/live.go`), "N errors since last glance" row (clears when clicked → opens window with `level:error` query), "Open LogSonic", "Quit".
- **Notifications:** `UNUserNotificationCenter` (request permission on first watcher creation, not app launch). One notification per watcher-event *burst* (coalesce ≤1 per watcher per 30 s; the coalescing lives in the shell). Clicking deep-links: open window and apply the watcher's query via `__logsonicPerformAction`/URL param.
- **Dock badge:** count of unseen error-level rows across active tails (from `LiveRowsEvent` level counts if present; else from watcher hits only — check what the event payload carries in `types.go:130` and decide at implementation time with a comment). Clears when the window becomes key.
- **Drop a file on the window, not just the Dock (added 2026-09-16 from ISSUES.md 2026-09-07).** Today only the Dock icon and Finder "Open With" reach `openNativeFiles`; a drop onto the window's content area is silently swallowed (the shell registers no `NSDraggingDestination`, and the SPA has no window-level drop target outside the Import wizard). Implement at the **AppKit layer, not the web layer**: `registerForDraggedTypes([.fileURL])` on the window's content view (or a thin `NSView` overlay), `draggingEntered`/`draggingUpdated` return `.copy` and show a visible drop highlight, `performDragOperation` reads the file URLs off the pasteboard and calls the existing `openNativeFiles(paths)` — the same entry point the Dock uses, so the now-08 path handoff, the removed 512 MB cap, and directory handling come along unchanged. A web-layer implementation would inherit the in-browser byte-reading path now-08 retired for Dock drops, so it is the wrong layer.

## Current-state anchors

- SSE endpoint + event shapes: `server.go:233`, `types.go:125–148`; browser consumption reference: `frontend/src/hooks/useLogStream.ts` + `stores/useLiveLogStore.ts` (read to mirror semantics: hello/rows/skipped/status).
- Pause/resume/stop routes: `server.go:277–280`.
- Shell lifecycle to modify: `LogsonicApp.swift` (window-close → SIGINT path; grep `windowShouldClose` / `applicationShouldTerminateAfterLastWindowClosed`).
- Watcher event contract: `specs/next-04-watchers-notifications.md` (build against its SSE event type `watch_alert`).
- Native file delivery entry point for window drops: `openNativeFiles` → `deliverNativePaths` in `LogsonicApp.swift` (the Dock / "Open With" path from now-08 phase 5); `grep -nE "registerForDraggedTypes|NSDraggingDestination|performDragOperation" backend/macos/*.swift` currently returns nothing.

## Step-by-step

1. Swift `LiveFeed.swift`: **extend** the minimal URLSession SSE listener that now-12 adds for `ui_focus` (do not write a second client) into a full client + event decoding (Codable structs mirroring `types.go` events) + reconnect with backoff; unit-test the parser on captured SSE fixtures.
2. `StatusItemController.swift` (new): builds/updates the NSStatusItem menu from LiveFeed state; rows/sec computed shell-side over a 5 s window.
3. Lifecycle change with `shouldStayAliveOnWindowClose` + Dock-reopen (`applicationShouldHandleReopen`) restoring the window.
4. Notifications: permission flow, coalescing, deep-link action.
5. Dock badge via `NSApp.dockTile.badgeLabel`; clear on window key.
6. Add new files to `scripts/app-macos.sh` swiftc lists; rebuild.
7. Window drop target (see design decision): drag-destination registration on the content view, highlight, `performDragOperation` → `openNativeFiles(paths)`. Independent of steps 1–5; can ship first.

## Test cases

**Swift unit:** SSE line-parser fixtures (hello, rows, status, malformed → skip not crash); `shouldStayAliveOnWindowClose` truth table; coalescing (3 alerts in 10 s → 1 notification; alert after 31 s → second); badge count arithmetic + clear.

**Manual matrix:**

| # | Check |
|---|------|
| M1 | `logsonic tail -f` a growing file → status item appears, shows source + rows/s |
| M2 | Pause from status menu → browser UI feed pauses too (shared subscriber semantics verified against `live.go`) — or shell-only subscriber pauses independently; whichever the implementation chose, behavior documented in PR |
| M3 | Close window during tail → app stays, server keeps indexing (verify via `curl /api/v1/ping` and doc counts) |
| M4 | Close window with nothing active → app quits, server SIGINTed (regression) |
| M5 | ⌘Q during tail → clean shutdown (indices close; no Force Quit needed) |
| M6 | Watcher fires → macOS notification; click → window opens with the query applied |
| M7 | 100 rapid watcher hits → ≤ a handful of notifications (coalescing) |
| M8 | Dock badge increments on errors, clears on focusing the window |
| M9 | Kill the backend process manually → status item shows disconnected state, no crash; existing maxServerRestarts logic unaffected |
| M10 | Drop a log file on the app *window* (search view, not the Import page) → drop highlight while hovering; on release the Import wizard opens on step 2 with the file's basename; a Dock-icon drop of the same file behaves identically (regression) |

## Acceptance criteria

- [ ] Full manual matrix on arm64; Swift unit tests green.
- [ ] No REST polling loops (SSE only, verified by server access logs).
- [ ] Window drop (M10) works from the search view; no `File`/`DataTransfer` byte path is introduced for it (it goes through `openNativeFiles`).
- [ ] Window-close semantics documented in README/installation docs and release notes. `docs/installation.md` currently says "Closing the app window stops the server" (still true; now-07 left it deliberately) — this bundle must rewrite that sentence when the stay-alive behavior lands.

## Out of scope

Self-update (next-11 decides the opt-in check policy first; Sparkle only after), watcher CRUD UI (next-04 owns it), Windows/Linux equivalents.
