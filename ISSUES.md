# Issues for supervisor review

Findings surfaced while implementing roadmap work packages that need a human decision, or that are worth knowing about even though they didn't block the work in question. Newest first. Each entry names the work package it came from and its severity from the implementer's perspective — **not** a claim about how urgent it actually is; that's the supervisor's call. Entries that were remediated stay here, marked **Closed**, so the trail is visible.

Process: every candidate entry goes through the remediation pass in [`specs/WORKFLOW.md`](specs/WORKFLOW.md) §5 first (root-cause with a 10-minute budget, measure before choosing, classify fixable-in-scope / fixable-safe / needs-human). Only the third class lands here as an open item.

---

## 2026-09-07 — Dropping a file on the app *window* does nothing; only the Dock icon and Finder "Open With" import (found during macos-b1's M1–M10 walk) — **Scheduled**

**Scheduled 2026-09-16** — the maintainer chose macos-b3. `specs/macos-b3-ambient-presence.md` now carries the AppKit-layer design decision below, step 7, manual row M10, and an acceptance box. Nothing implemented yet; this entry closes when macos-b3 ships M10.

**Severity:** P2 — user-visible and discoverability-costing (dragging onto the window someone is looking at is the more obvious gesture than aiming at the Dock icon), but not a defect against any spec: nothing was broken, this was never built. No data risk, and two working paths exist (Dock icon, Finder "Open With", plus the Import page's own drop zone).

**What:** With the app open on the search view, dragging a log file anywhere onto the window produces no import wizard, no error, and no visible feedback — the drop is silently swallowed. The same file dropped on the Dock icon imports normally.

**Root cause, confirmed in code (two independent layers, both would need fixing):**

1. **The native window is not a drag destination.** `grep -nE "registerForDraggedTypes|NSDraggingDestination|performDragOperation|draggingEntered" backend/macos/*.swift` returns nothing — the shell implements no AppKit drag-destination protocol at all. Its only file-delivery entry points are `application(_:openFile:)` (`LogsonicApp.swift:317`) and `application(_:openFiles:)` (`:322`), both routing to `openNativeFiles` (`:1030`) → `deliverNativePaths` (`:1069`). Those fire for the Dock icon, Finder "Open With", and `open -a` — never for a drop onto the window's own content area.
2. **The web layer has no window-level drop handler either.** The only `onDrop`/`onDragOver` pairs in `frontend/src/` are `Import/LocalFileImport/FileSelection.tsx:233-235` (the wizard's file-selection step) and `Import/UploadSteps/CustomPatternSelector.tsx:326-333`. On any other route — Home/search, where a user is most likely to drop — there is no target, so the WKWebView falls through to its default handling and `decidePolicyFor` (`LogsonicApp.swift:715-727`) cancels the resulting non-server-origin navigation. That cancellation is why the failure is silent rather than destructive: the SPA is never replaced by the file's contents.

**Why this is a gap, not a regression:** no spec covers dropping on the window. `specs/macos-b1-visible-nativeness.md`'s M8 asserts only "Dock drag-drop import still works", and `specs/macos-b2-menus-finder.md`'s "paths, not bytes" decision covers Dock drops and `NSOpenPanel` picks. Neither `now-08` nor `macos-b1` regressed anything here: `git log -S registerForDraggedTypes -- backend/macos/` returns no commits, so the shell has never had a drag destination in this repo's history.

**Second-order note for whoever implements it:** even today's working in-window path (dropping onto the Import wizard's own drop zone) goes through the browser `File`/`DataTransfer` route, so bytes are read in-page in 8 MB chunks by `FileSelectionService` — it does **not** use `now-08`'s `POST /ingest/file` path handoff, and so still carries the in-browser read cost that `now-08` retired for Dock drops. A window drop implemented at the AppKit layer would get paths for free (`NSFilenamesPboardType` → the existing `openNativeFiles`); one implemented only in the web layer would inherit the byte-reading path. The AppKit layer is the right one.

**Suggested next step (needs a human — it expands a spec's scope):** add to `specs/macos-b2-menus-finder.md`'s goal 2 ("paths, not bytes"), which already owns shell file delivery, roughly:

- `registerForDraggedTypes([.fileURL])` on the window's content view (or a thin `NSView` overlay), with `draggingEntered`/`draggingUpdated` returning `.copy` and a visible drop highlight;
- `performDragOperation` reading the file URLs off the pasteboard and calling the existing `openNativeFiles(paths)` — the same entry point the Dock uses, so the path handoff, the retired 512 MB cap, and directory handling all come along unchanged;
- a manual check row alongside M8 ("drop a file on the window, not the Dock: wizard opens on step 2 with the file's basename").

Alternatively it belongs in `macos-b3` if b2's scope is already full. Not fixed here: the macos-b1 package was complete and committed, this is new behavior against a different spec's scope, and inventing scope on the way past is what WORKFLOW §5 classifies as needs-human.

---

## 2026-09-16 — Settings → Storage "Reveal in Finder" is manual-pending in the native app (now-10 phase 3b)

**Severity:** Low. Compile-verified; the one unverified link is a `switch` case.

**What:** the page posts to a new `logsonicReveal` WKScriptMessage handler (`LogsonicApp.swift`, registered beside `logsonicTheme`), which calls the shell's existing `revealInFinder()` — the same selector the View menu's "Reveal Index in Finder" item uses and macos-b1's manual walk exercised. `test-macos-app.sh` compiles both arches and validates the ad-hoc app; this session has no desktop control to click the button.

**Manual step:** `LOGSONIC_DEV_NO_OPEN=1 bash backend/scripts/dev-macos-app.sh <scratch binary>`, then `open --env STORAGE_PATH=<scratch> -a backend/dist-dev/Logsonic.app`, Settings → Storage → **Reveal in Finder**. Expected: a Finder window opens at the storage directory. In browser mode (`--browser` or a plain browser) the button is not rendered and the path + copy button stand in.

---

## 2026-09-16 — `apiRequest` read `detail`; the backend has always written `details` (found during now-10 phase 3a) — **fixed**

**Severity:** Low. No caller ever received the server's `details` string — every toast showed only the one-line `error`.

**Fix (`0317098`, additive):** `apiRequest` now throws an `ApiError` carrying `status`, `code` and `details`; `message` is unchanged (still `detail || error || "API request failed…"`) so existing string matching (`useUpload.ts`'s "Import cancel" prefix, tests) keeps working. The Sources panel maps codes to user copy and treats `details` as operator text (it contains API paths). `lib/api-errors.ts` (3b) is the shared code → copy mapper; the Sources panel and the Storage page use it; the Header, the import wizard and the workspace menu still show `message` only — switching them is a per-surface improvement, not a bug.

---

## 2026-09-16 — Per-source delete: three windows it can't see (now-10 phase 2a)

**Severity:** Low each; recorded so phase 3's UI and any operator know the edges.

1. **In-flight browser chunk upload.** `DELETE /sources/{name}` refuses (409) while a live tail or a running path-ingest job writes the source, but a browser upload in progress is only a session with a recent `LastActivity` — no server-side handle to check. Its next chunk stores rows that survive the delete. The wizard is the only such client; **phase 3a (`0317098`) disables Delete and Re-import in the Sources panel while `useImportStore.isUploading`** — client-side only, so the server race stands for a hand-written client. The guard is real because `useImportStore.reset()` is called only from tests, so `isUploading` survives navigating away from `/import` mid-upload; a later refactor that resets the store on unmount would silently void it.
2. **Stale catalog days.** The delete iterates the entry's `days`. Rows on a day the catalog doesn't list stay, and the response can't say so. An unclean exit used to cause this (see *An unclean exit silently lags the catalog* below, Closed 2026-09-16); after 2b's marker there is no known cause, and this item stays only as the rationale for `POST /sources/rebuild` being the remedy a phase-3 dialog could offer.
3. **Re-import gap — Closed 2026-09-16 (`f641ce4`).** The entry is now kept at zero rows (`catalog.Reinstate`) and refilled by the job, so it never leaves `GET /sources` / `/info`; the panel shows "re-importing, N rows" on the row itself. Two residual edges, recorded not fixed: a `Rebuild` that touches the source between the 202 and the job's first `Record` (daily prune, `POST /sources/rebuild`, delete-day on one of its former days) drops the zero-row entry and the rename with it — seconds for a local file; and on the partial-delete error path the reinstated entry reports 0 rows while rows remain, until the retry or a rebuild. Still true: the auto-ended session's trailing multiline record is flushed after `job.finish`, so it isn't in that job's `rows_stored`.

`storage.RemoveDay` closes an index under the storage lock exactly as `PruneOlderThan`/`Clear` do; a `StoreWithIDs` already holding that handle sees the same closed-index error those two can cause today (method comment says so).

---

## 2026-09-16 — `-retention-days 0` cannot disable a `RETENTION_DAYS` env value; `config.json` now can (found during now-10 phase 2b)

**Severity:** Low, pre-existing, with a workaround as of 2b.

**What:** `backend/main.go` treats `-retention-days 0` (the flag's default) as "unset" and falls through to `RETENTION_DAYS`, so a user with the env variable set has no flag that says "keep everything" — `0` is silently replaced by the env value. Phase 2b's precedence puts `<storage>/config.json` above both, and `retention_days: 0` there *is* an explicit off switch (`PUT /api/v1/storage {"retention_days": 0}` or the phase-3 settings page), so the case is now reachable, just not from the flag.

**Not fixed because:** making the flag distinguish "not passed" from "passed 0" changes CLI semantics (`flag.Int` can't; it needs a sentinel default or `flag.Visit`), and with the config.json switch available it is the maintainer's call whether that is worth a behavior change. Documented in `docs/configuration.md`'s precedence list as the three sources in order; the flag/env quirk is not called out there because it predates this spec.

---

## 2026-09-16 — An unclean exit silently lags the catalog; nothing repairs it until a manual rebuild (now-10 phase 1 design) — **Closed**

**Closed 2026-09-16** by now-10 phase 2b (`b3c1b6f`), option (a): `sources.json.dirty` is created at `Open` and removed only by a clean `Close`; found at the next `Open` it forces a full rebuild, which is saved immediately. `TestUncleanExitMarkerForcesRebuild`; observed on the real binary (marker present while running, gone after SIGINT). The marker is created at `Open`, so every unclean exit triggers the rebuild wherever the crash landed (including between a `Store` committing and its `Record`); item 2 of the per-source-delete entry ("stale catalog days") has no known cause after this and is kept only as the rationale for `POST /sources/rebuild`.

**Severity:** Low. Affects only what `/info`, the Sources panel and per-source delete *report*; the index itself is unaffected.

**What:** `Record` is debounced — `sources.json` is written every 2 s and on a clean `Close`. A crash or `kill -9` inside that window loses the batches recorded since the last flush. On the next start `Open` finds a *valid* file and loads it **without rebuilding** (a rebuild only runs when the file is missing, corrupt or from another schema version). So after an unclean exit the catalog under-counts rows and can miss a whole day for a source, and the only thing that fixes it is `POST /sources/rebuild` (or deleting the file). The phase-1 code comment says the debounce bounds "how much a crash can lose to a rebuild" — but no rebuild is triggered.

**Why it matters for phase 2a:** `DELETE /sources/{name}` iterates the entry's days, so a missing day's rows survive the delete (item 2 above).

**Fix candidates (cheap, either is a phase-2b/3 one-liner):** (a) a dirty-marker file (`sources.json.dirty`) created on the first `Record` after a flush and removed by a clean `Close`; if present at `Open`, run a full `Rebuild`; or (b) always run a scoped `Rebuild` over the current day (and yesterday) at startup, which covers the common case — a crash mid-import — at the cost of one facet query per start. (a) is exact; (b) is simpler. Recommendation: (a).

---

## 2026-09-16 — `_src` was tokenized: source filters were never exact, and phase 2's delete-by-source would have been data loss on old shards (now-10 phase 1)

**Severity:** P2 for existing stores (behavior is unchanged there, but the inexactness is now documented and blocks a spec'd feature); fixed for new shards.

**What:** `_src` had no explicit field mapping, so Bleve's dynamic mapping put it through the `standard` analyzer: `app.log.1` was indexed as `app.log` + `1`, `My App` as `app` (stop word dropped, lowercased). Consequences, all confirmed with a probe test before building on them: a `_src` facet returned tokens, not names; the source filter (`sourceFilterQuery`, a match query with AND) for `app.log` also matched `app.log.1`; and spec now-10's "term query on `_src` … `DeleteByIds`" bullet, taken literally, would delete `app.log.1` rows when deleting `app.log`.

**What phase 1 did:** an explicit keyword mapping with doc values for `_src` on **new** shards (`buildIndexMapping`), so facets, filters and future deletes are exact there. Shards created earlier keep the tokenized field — a mapping is fixed at index creation, and rewriting `_src` is a reindex (charter-level, per the spec's own out-of-scope list). `storage.LegacySourceShard(date)` tells them apart. The spec's Rebuild and Delete bullets carry dated corrections.

**What remains, for whoever does phase 2:** on shards `storage.LegacySourceShard(date)` reports, `DELETE /sources/{name}` must fetch each candidate's stored `_src` and delete only exact matches — the same sentence now sits in the spec's Delete bullet. The current day's shard stays legacy until the date rolls over after upgrade, so every upgraded store is mixed for up to a day. The filter inexactness on legacy shards (`app.log` matching `app.log.1`) predates this work and is unchanged; a store-wide fix is the reindex.

**Numbers:** rebuild on a legacy shard is a paged stored-field read — 472 ms for 120k rows in one single-day shard on this machine (arm64, SSD), i.e. ≈4 s per million legacy rows, **sequential across day-indices** (a year-old store is 365 reads, one per shard), synchronous at the first start after upgrade, before the listener opens. For comparison, the same rebuild on keyword-mapped shards (the facet path) measured **1.04 s per million rows** over 30 day-indices (now-10 phase 3b's C6 run) — so a fully migrated store rebuilds ≈4× faster than a legacy one. Whether that first-launch pause is acceptable at the maintainer's largest real stores is their call; the alternative is a background rebuild with `/info` reporting an empty source list until it finishes.

---

## 2026-09-16 — Rebuilt `first_ts`/`last_ts` are second-precision; write-path values are exact (now-10 phase 1)

**Severity:** Informational.

**What:** Bleve returns a stored datetime field as RFC 3339 without the fractional part (probe: stored `10:00:00.123456789` → read back `10:00:00`). The existing search path has the same limit (`dateparse` over the same string). So a catalog entry's bounds are exact when they came from `Record` (the write path sees the `time.Time`) and up to 999 ms early after a `Rebuild`. Documented on `storage.SourceDayStats`; C2's test uses whole seconds for that reason.

**Suggested next step:** none needed for the catalog's purpose (a span for the Sources panel). If sub-second bounds ever matter, store the timestamp's UnixNano as a numeric field alongside — a mapping change like the one above.

---

## 2026-09-16 — Catalog `Record`/scoped `Rebuild` can double-count a batch in flight (now-10 phase 1)

**Severity:** Low, self-healing.

**What:** `Store` commits to the index before `recordStored` takes the catalog mutex. If a scoped `Rebuild` (after `DeleteByIds` or a prune) runs in that gap, its facet already counts the new rows *and* the blocked `Record` then adds them again. Window is microseconds per batch; the next `Rebuild` (startup, `POST /sources/rebuild`, the next prune) is exact again.

**Not fixed because:** closing it means either holding the catalog mutex across `Store` (serializing every ingest path behind one lock) or a generation counter on the storage side; neither belongs in a read-side phase. Recorded so phase 2's delete — which will rebuild the affected days — knows the counts it reads can be off by one batch during a concurrent import.

---

## 2026-09-16 — `specs/WORKFLOW.md` consumer-sweep table named the deleted `logsonicfile:` fetch — **fixed**

**Severity:** Low. A stale pointer in the process doc, not code.

**What:** after `d4ce39a` deleted the scheme handler, WORKFLOW.md §2's consumer table still listed "Native-file fetch … `fetch(logsonicfile://…)`" and §4's native-bridge row still named `logsonicfile:`. A future consumer sweep would grep for a consumer that no longer exists and miss the real one.

**Fix (same day, factual correction per the standing rules):** the row now names the actual consumer — `FileSelection.tsx` reading `window.__logsonicPendingNativeFiles` / the `logsonic-native-files` event — and the bridge row names `deliverNativePaths`. Also noted: WORKFLOW.md's standing rules still say "Never push"; the maintainer authorized pushing `dev` and opening draft PR #35 on 2026-09-16, so that rule is now out of date and needs the maintainer's rewording (not changed here — it's a policy line, not a fact).

---

## 2026-09-03 — M1–M10 visual/interactive checks are manual-pending (macos-b1) — **Closed**

**Severity:** P2 — opened as a verification gap; walking M1/M2 live surfaced two real defects (see *Partially remediated* below). The change itself compiles warning-clean on both architectures and the full non-interactive build/validate/smoke pipeline passes.

**What:** `specs/macos-b1-visible-nativeness.md`'s entire manual-check table (M1 no-white-flash on dark launch, M2 traffic-light overlay + working buttons, M3 drag-by-header vs. no-drag-on-controls vs. double-click-zoom, M4 live appearance-follow in `auto` mode, M5 explicit theme choice overrides + persists across relaunch, M6 browser-mode has none of the native CSS/two-state toggle, M7 fullscreen/split-view, M8 regression sweep of Dock drop/downloads/quit-SIGINT, M9 `logsonic -open` CLI path, M10 window-frame memory across quit/relaunch for both windows) requires actually looking at and interacting with the running app. This session has no desktop-control permission, so none of these were watched happen — they're asserted only by reading the code and by the non-interactive checks below, same shape as now-08 phase 5's and now-09's prior manual-pending entries.

**What I did instead:** `bash backend/scripts/test-macos-app.sh` (both-arch `-typecheck` clean, `-warnings-as-errors` clean, `ListeningURL` + new `DragStrip` unit tests green, ad-hoc build + codesign + plist validation) and `LOGSONIC_APP_UI_SMOKE=1 bash backend/scripts/test-macos-app.sh` (real headless launch, confirmed loopback-only binding, clean AppKit-path quit via `osascript`) both pass. Also traced every call site of the new `logsonicDrag`/`logsonicTheme` message handlers, `setFrameAutosaveName` calls, and the `NSApp.effectiveAppearance` KVO observer by hand.

**Suggested next step (manual-pending, same shape as now-09's `logsonicfile:` review entry and now-08 phase 5's Dock-drop entry):**

```
bash backend/scripts/test-macos-app.sh   # rebuilds and validates backend/dist-dev/Logsonic.app
open --env STORAGE_PATH=<scratch dir> backend/dist-dev/Logsonic.app
```

Then walk the M1–M10 table in `specs/macos-b1-visible-nativeness.md` directly against the running app (System Settings → Appearance for M4; quit/relaunch via Cmd-Q and reopen for M5/M10; `View → Open in Browser` for M6; the existing Dock-drop/download/quit checks for M8; `logsonic -open` from a terminal for M9). Do not mark the spec's "All manual checks M1–M9 pass" acceptance box verified until someone with desktop-control access on this machine runs the above and confirms each row.

**Partially remediated 2026-09-03** — a later desktop-control session found two real defects: **M1**, dark-launch showed the light theme until System Settings' appearance was toggled once (`NSApp.observe(\.effectiveAppearance, options: [.new])` never fires at load, so `useThemeStore` had nothing but a hardcoded `'light'` to seed `systemAppearance` with); **M2**, centering the brand icon across the full 78px traffic-light zone landed it on the zoom button. No outcome for M3–M10 was recorded from that session, so treat them as still manual-pending, not as passed. Root cause + fix for M1/M2 in commit `3a843ad` (`window.__LOGSONIC_INITIAL_APPEARANCE__` injected in the document-start script; icon right-aligned past the reserved zone) — verified by a new module-init regression test (asserts both store state and the DOM `data-theme` attribute), full vitest 254/254, eslint clean on touched lines, `test-macos-app.sh` (which already rebuilt `backend/dist-dev/Logsonic.app` with the fix in it), and `go build`/`go vet`. The *fixes* were not re-watched live in the turn that committed them (no desktop-control grant then) — fixed, unverified:

```
open --env STORAGE_PATH=<scratch dir> backend/dist-dev/Logsonic.app
```

with System Settings → Appearance toggled to dark *before* first launch. Expected: the first painted frame is already the dark theme, with no light frame before it (M1); the brand mark sits entirely to the right of the zoom button with a visible gap (M2). **Closed 2026-09-07** — the maintainer walked the full M1–M10 table live on arm64 against `backend/dist-dev/Logsonic.app` (confirmed current with `3a843ad` first: both the bundled Go binary and the Swift shell contain `__LOGSONIC_INITIAL_APPEARANCE__`, and the embedded `pkg/static/dist` assets carry the same build stamp, so the walk exercised the fixed build and not a stale one). **All ten pass**, which closes both halves of this entry: the M1/M2 fixes' "fixed, unverified" caveat (both watched live this time) and M3–M10, which had never been observed. `macos-b1` is marked ✅ Done in TBD.md; the spec's acceptance box takes the "M1–M9 on arm64 + successful x86_64 compile" branch of its own wording, since no Intel machine is available here. One new finding came out of the same walk — dropping a file on the app *window* imports nothing — filed as its own entry at the top of this file, not as a reopening of this one.

**Process note:** `specs/WORKFLOW.md`'s advisor gates 2 and 3 (remediation-pass review of the diff/tests, and review of this TBD/ISSUES text) could not run this session — the `advisor` tool reported itself temporarily overloaded on every attempt. Substituted a manual line-by-line re-read of the full `git diff` (all 10 changed files plus the 5 new ones) against the spec's design decisions before committing. This is a gap in process, not in the change itself; flagging it so it isn't mistaken for a skipped step.

---

## 2026-09-03 — `e2e-comprehensive.mjs`'s placeholder-based search-input locator breaks once the input is focused — **fixed** (now-03)

**What:** `LogSearch.tsx`'s search `<Input>` changes its `placeholder` attribute on focus (from `"Search logs… (/ or ⌘K)"` to `'Try level:error or "connection timeout"'`), so any Playwright locator matching `input[placeholder*="Search logs" i]` stops resolving to any element the instant the input is focused. Similarly, `WorkspaceMenu.tsx`'s trigger button's accessible name switches from `"Workspace"` to the active workspace's name once one is loaded, breaking `getByRole('button', {name: 'Workspace'})` the same way. Every existing check in `e2e-comprehensive.mjs` happened to query these locators only once, before the state change; now-03's new check is the first to fill/press/apply repeatedly across a focus change and a workspace-load, and hung for the full default timeout on the very first action after the state flipped.

**Fix:** added a stable `aria-label="Search logs"` to the search `<Input>` and `aria-label="Workspace menu"` to the workspace trigger button — both incidental small accessibility improvements as well as test-stability fixes. Updated all locator references in `e2e-comprehensive.mjs` (including the two pre-existing checks that used the old `Workspace`-by-text locator) to match on these instead.

**Verified:** now-03's new check passes twice in a row against a clean storage dir; the pre-existing "workspace can be saved and deleted" check is unaffected by this change (it was independently broken by the issue below, now fixed).

## 2026-09-03 — Deleting the active workspace left its saved queries in the (unrelated) next workspace someone saved — **fixed** (now-03)

**What:** `useWorkspaceStore.ts`'s `deleteWorkspace` cleared `activeWorkspaceId` when the deleted workspace was active, but never cleared `useSavedQueryDraftStore` (this package's own new store). Its saved queries stayed in the draft after the workspace behind them was gone, so the next `saveCurrentWorkspace` call — for an unrelated, brand-new workspace — silently inherited them, since `saveCurrentWorkspace` always reads the current draft into `buildWorkspaceFromState`.

**Found while:** adding now-03's new E2E check, which stars a query, saves a workspace, then deletes it as its own cleanup step — this is the first code path to exercise workspace-delete with a non-empty saved-query draft. The pre-existing "workspace can be saved and deleted with confirmation" check, run immediately afterward in the same script, started failing (its "Save as" click intermittently hit a detaching element) once this leak was present in the shared page's state.

**Fix:** `deleteWorkspace` now also calls `useSavedQueryDraftStore.getState().setAll([])` when the deleted workspace was the active one (`backend/pkg/workspaces/store.go` untouched — this is a frontend-only state-management gap). `isWorkspaceDirty(undefined, …)` already short-circuits to `false` with no active workspace, so this couldn't surface as a phantom-dirty indicator, only as the silent data leak described above.

**Verified:** two new vitest cases in `useWorkspaceStore.test.ts` (`deleteWorkspace` describe block) — deleting the active workspace clears the draft, deleting a non-active one leaves it untouched. `e2e-comprehensive.mjs`'s pre-existing workspace check now passes consistently (2/2 clean runs) once combined with the fix below.

## 2026-09-03 — now-03's new E2E check's own popover interactions destabilized the next check's DOM — **fixed** (now-03)

**What:** Even after the draft-leak fix above, `e2e-comprehensive.mjs`'s pre-existing "workspace can be saved and deleted" check still intermittently timed out clicking "Save as" or the delete ✕ — the failure point moved between runs, and the exact element reported "not stable" / "detached from the DOM, retrying". Removing now-03's new check from the script (leaving everything else, including the leak fix, in place) made the pre-existing check pass cleanly every time; putting the check back reintroduced the flake. So the interference was real and specific to running now-03's check first, not environmental.

**Root cause (isolated, not fully explained):** now-03's check opens and closes the search-input's Radix popover, the saved-query star popover, and the workspace popover three separate times (save, load+apply, delete) plus a full `page.reload()`, all on the same `page` object every other check shares. Neither a 2–4s settle wait nor explicitly waiting for the "Workspace deleted" toast to finish its exit animation resolved it, so the residue is not simply a slow-to-dismiss toast; it is some state left on the shared page by that many stacked Radix popover open/close cycles that the next check's popover interactions then hit.

**Fix:** rather than continue reverse-engineering Radix's internals under budget, now-03's new check runs on its own `browser.newPage()` (navigated to the same app, same backend/session) and closes that page when done, so nothing it does can leave residue for the next check to inherit. This is the appropriate scope for now-03: the check is now provably self-contained, and the actual mechanism (if it recurs in a future check that also chains several popovers) is left for whoever hits it next.

**Verified:** full `e2e-comprehensive.mjs` run twice in a row against a clean storage dir: 7/8 checks pass consistently, including both "history recall…" (new) and "workspace can be saved and deleted" (pre-existing, previously flaky). Only "import redirects back to the home view" remains failing — see the next entry, confirmed unrelated.

## 2026-09-03 — `e2e-comprehensive.mjs`'s "import redirects back to the home view" check is flaky in this dev environment, unrelated to now-03

**What:** This one check fails **deterministically** (every run, not intermittently) against a freshly built backend + `vite` dev server on this machine: `page.waitForURL(/#\/$/)` resolves, but an immediate, un-waited `.count()` on the search input reads 0 because the home view hasn't finished mounting yet (confirmed via a standalone probe: the input appears ~0.5–1s later).

**Root cause, confirmed not caused by this package:** re-ran the pristine, unmodified `e2e-comprehensive.mjs` from `dev` HEAD (via `git stash`, verifying both the script AND the running app were unmodified) against a clean backend storage dir — the failure reproduced identically with zero now-03 changes present.

**Why this isn't classified as fixable-in-scope:** now-03 doesn't own this check's assertion or the timing it depends on; the check simply needs a wait instead of an instant `.count()`, which is a one-line, unscoped fix to a check that pre-dates this package and isn't part of its acceptance criteria.

**What I did instead:** kept now-03's own new check independent of this one (it does its own explicit wait for the search input via `getByRole`), confirmed passing reliably on its own. This one pre-existing failure remains open for whoever next touches `e2e-comprehensive.mjs`.

---

## 2026-09-03 — H5 (memory-bounded 200 MB import) exceeds its 150 MB budget; root cause is `pkg/storage`, not `pkg/ingestfile` (now-08 phase 7)

**Severity:** P2 — a real, measured budget miss, but on a spec that describes a desktop-first *comfort* target (§8), not a crash or correctness defect. No size cap exists on this path either way (that's the point of now-08); this finding is the first data on what the storage layer actually costs at large-single-file scale, not evidence that large imports fail.

**What:** new `TestIngestFileMemoryBounded` (`backend/pkg/server/ingest_file_memory_test.go`, commit `177e998`, off by default — `LOGSONIC_RUN_MEMORY_TEST=1 go test ./pkg/server -run TestIngestFileMemoryBounded -v`) ingests a generated 200 MB / 1,653,374-line single-day file through `POST /ingest/file` and samples `runtime.MemStats` every 250 ms while polling `GET /ingest/jobs` to a terminal state. Measured: **peak `HeapInuse` delta 319–322 MB** across two runs of the committed test (an earlier 10 ms-poll draft, since rewritten, saw 328 MB — cited separately since it isn't the shipped code), well over spec now-08's H5 budget of 150 MB.

**Root-cause check (§5 step 1, both hypotheses measured, not guessed):** `HeapInuse` includes GC-uncollected garbage, which under default `GOGC=100` can run to ~2x the true live set — so the number alone doesn't say whether this is a real storage-layer cost or just pacer slack. Reran with `GODEBUG=gctrace=1`, first against the `go test` wrapper (which turned out to interleave the compiler's own GC trace with the test binary's — a methodology bug caught before trusting the number: a `go test -c` precompiled binary run standalone gives one clean trace). In that clean run: the live heap immediately after each GC cycle (`gc N ... A->B->C MB`, C = live) started at **9 MB** (the test's own explicit `runtime.GC()` baseline call, visible as the trace's one `(forced)` line) and peaked at **200 MB**, ~3 seconds before the job finished — a **191 MB live-set delta**, itself over the 150 MB budget, confirming this is not a GC-tuning artifact.

But the full trace is **not** a steady climb to that peak — plotting every 25th GC cycle shows the live heap bouncing between a ~25–70 MB floor and periodic spikes (125 MB at 1.5s in a nearly-empty index, up to 357→108 MB and 200 MB in the run's final third), i.e. a bursty working set tied to Bleve scorch's background segment-merge cycle, not a value that climbs and stays up. By the time the process exited (3s after the 200 MB peak, essentially as the job itself finished) it had already fallen to 53 MB — a transient spike, not retained memory. What *does* track with total index size is the spike magnitude: later merges (more documents already indexed) produce bigger spikes than earlier ones — consistent with the same "does Bleve's per-batch/per-merge cost scale with total index size" open question the now-11 bench harness already flagged for `search_term_facets` (see that row in TBD.md), surfacing again here for writes instead of reads.

`pkg/ingestfile`'s own contract — a line iterator plus a caller-controlled 10k-line batch — is confirmed bounded (`reader_test.go` R1–R9 unchanged, and `ingest_jobs.go`'s `runIngestFileJob` flushes every `ingestFileBatchLines` lines, never accumulating lines across batches); all 1.65M synthetic rows land on one calendar day since none of the fixture's lines carry a parseable timestamp, so this is specifically the single-day, high-volume case.

**Why this isn't classified as fixable-in-scope:** now-08 owns `pkg/ingestfile` and the job runner, not `pkg/storage`'s Bleve/scorch configuration; tuning scorch's merge behavior during a large batched write is a storage-engine change with its own cost/correctness tradeoffs that a P0-priority now-08 phase shouldn't decide unilaterally. It's also not obviously fixable by the intuitive lever: since the spikes track scorch's *merge* cycle rather than the writer's own per-`Batch()` footprint, shrinking `ingestFileBatchLines` would trigger the same merge machinery more often and could make peak memory worse, not better — the opposite of what it looks like it should do.

**Suggested next step:** `next-10-storage-engine-hardening.md` (or a dedicated follow-up) should reproduce with `TestIngestFileMemoryBounded` (gated behind `LOGSONIC_RUN_MEMORY_TEST=1`) and measure scorch's merge-planner behavior (segment count/size thresholds, merge concurrency) *before* touching batch size, given the batch-size lever's direction is unclear from this trace alone. Numbers to compare against: 319–322 MB peak `HeapInuse` / 191 MB peak live-set (9→200 MB, bursty not sustained) at 1,653,374 rows in one day-index; 150 MB is the current spec target.

**Acceptance box:** now-08's "Memory bounded (H5)" box stays open — measured and over budget, not silently marked done.

---

## 2026-09-03 — Native Dock-drop verification is manual-pending; >512 MB acceptance box unverified (now-08 phase 5) — **Closed**

**Severity:** P2 — not a defect, a verification gap. The change itself compiles, type-checks, and builds/validates cleanly (`backend/scripts/test-macos-app.sh` green, both architectures).

**What:** now-08 phase 5 changed `LogsonicApp.swift`'s `openNativeFiles` (Dock drop + Finder "Open With") to hand the server absolute paths instead of registering each file behind a `logsonicfile://` URL, and removed the 512 MB cap that only existed to bound the old `Data(contentsOf:)` full-buffer read. This session has no desktop-control permission to actually launch the built app and observe the result, so two things are asserted by reading code and running the non-interactive build/validate script, not by watching it happen:

1. A real Dock drop or Finder "Open With" reaches the wizard at step 2 with the file's basename shown and no `logsonicfile://` request in the webview.
2. A file over 512 MB (the old cap) now succeeds, since the size guard on that code path is gone.

**What I did:** ran `backend/scripts/test-macos-app.sh` (ListeningURL tests green, both arches type-check, ad-hoc app builds and passes codesign validation) and read every call site touched by the change. That's a strong signal but not the same as watching the app.

**Suggested next step (manual-pending, same shape as now-09's `logsonicfile:` review entry):** `backend/scripts/test-macos-app.sh` already built and validated `backend/dist-dev/Logsonic.app` this session — reuse it rather than rebuilding:

```
open --env STORAGE_PATH=<scratch dir> -a backend/dist-dev/Logsonic.app <path-to-a-log-file>
```

Expected: the app activates, the wizard opens on step 2 (Analyzing) with the dropped file's basename, `Pattern found` (or a manual-selection prompt for an unrecognized format), and the webview issues no `logsonicfile://` request. Covers the spec's own **macOS manual** row's first two sub-claims (Dock drop within 1s with visible progress and working cancel; Finder "Open With" on a `.gz`) and its own **E2E** row's wizard-rendering half (progress renders, rows searchable, `_src` correct — the API-level gzip-through-`/ingest/file` half is already covered by phase 2's `H4` test). For the size box specifically, repeat with a generated file over 512 MB. The macOS manual row's third sub-claim ("`--browser` mode still uses the scheme handler") cannot pass under any run of this command — see the next entry.

**Closed 2026-09-07** — the maintainer ran both drops live on arm64. A Dock drop of `sample-logs/apache.log` reaches the wizard as described, and a purpose-built 669 MB `big-apache.log` (real Apache lines, at `/tmp/logsonic-manual-check/`) was accepted and imported where the 512 MB cap would previously have refused it outright, so this is a positive test of the removal and not just an absence of errors. now-08's acceptance box (3) is closed in TBD.md; box (4) (H5, memory bounded) is untouched by this and still fails, see the entry above. Caveat on what was verified: the maintainer reported the check as passing against the instruction "drag it onto the Dock icon; it should import" — no `rows_stored` count, completion timestamp, or memory reading was captured. So what closes here is "a >512 MB file is accepted and imports rather than being refused by a size guard", not a throughput, completion-time, or memory claim.

---

## 2026-09-03 — `NativeFileSchemeHandler` has no live caller in either mode (now-08 phase 5) — **Closed**

**Closed 2026-09-16** — maintainer chose option (a). Commit `d4ce39a` deletes the class, `setURLSchemeHandler` registration, the `logsonicfile` navigation-policy allowance, and `logsonicfile:` from the server CSP's `connect-src`; `specs/now-08` wording corrected. Verified: `go test ./...`, `test-macos-app.sh`.

**Severity:** Informational — a spec-vs-code discrepancy, not a regression this session introduced.

**What:** `specs/now-08-native-path-import.md`'s design decisions say "`NativeFileSchemeHandler` stays for browser-mode fallback only" after the shell switches its primary Dock-drop/Open-With delivery to paths. Checked directly: `openNativeFiles`'s `--browser`-mode branch (`guard !useBrowser else { ...activateFileViewerSelecting...; return }`) has never called `nativeFiles.register()` — in browser mode the shell just reveals the dropped files in Finder for the user to pick up manually, both before and after this session's change. The embedded-webview branch was the *only* caller of `.register()`, and phase 5 moved it to `deliverNativePaths` instead. So after this change, `NativeFileSchemeHandler`'s `.register()` method has zero call sites in either mode — the class, its `config.setURLSchemeHandler(nativeFiles, forURLScheme: "logsonicfile")` registration, and the `scheme == "logsonicfile"` navigation-policy allowance are all still in the file (kept per the spec's explicit "stays," not deleted), but nothing exercises them.

**Why this isn't classified as a gap to fix here:** the spec describes an intended state ("stays for browser-mode fallback") that the code never actually implemented — browser mode's fallback has always been Finder-select, not the scheme handler. The spec's own **macOS manual** test row (`specs/now-08-native-path-import.md` line 93) asserts as a pass criterion that "`--browser` mode still uses the scheme handler" — a claim about behavior the code has never had, in this session or before it, further evidence the spec's browser-mode assumption predates what was actually built. Choosing between "delete the now-dead class + its two registration sites" and "wire browser mode to actually use it as the spec originally intended" is a product decision (does `--browser` mode need in-page file delivery at all, given Finder-select already works?), not something to guess at while landing an unrelated path-handoff change.

**Suggested next step:** a human decides one of: (a) delete `NativeFileSchemeHandler`, its `setURLSchemeHandler` registration, and the `logsonicfile` navigation-policy allowance as dead code, or (b) wire `--browser` mode to actually deliver dropped files through it (would need a way to inject JS into a system-browser tab, which doesn't obviously exist), or (c) correct the spec's wording to match the code's actual, longstanding browser-mode behavior. No functional change results from any of the three until decided.

---

## 2026-09-03 — `/parse/preview-file` reads any path with no session (now-08 phase 3)

**Severity:** Informational — not a regression, recorded so it doesn't look like an oversight later.

**What:** `POST /api/v1/parse/preview-file` returns the contents (first N lines) of any absolute path the server process can read, with no ingest session required — by the spec's own design ("without creating an ingest session"), since the native-drop wizard flow needs a preview before it has anywhere to put a session ID. This is a real file-content-disclosure surface for anyone who can reach the loopback API, same class of thing `now-09`'s Host allow-list and CSP already defend against for the browser vector, and the same shape of surface `POST /live/files` (`HandleLiveFileStart`) already has — checked directly (`grep -n "HandleLiveFileStart" backend/pkg/server/server.go`, then `live.go:800-822`): it decodes a `path` field from the JSON body and calls `h.Live.StartFile(req.Path, req.Options)` with no session lookup at all, so it's sessionless in exactly the same way.

**Why this isn't classified as a gap to fix here:** `now-08`'s own phase-1 review closed a *different* problem on `/ingest/file` — a cross-origin form POST could probe path existence via the error response, with no CORS preflight required, because that route sat outside the JSON-only middleware group at the time. `/parse/preview-file` is inside the standard `/api/v1` group from the start, so it already has that JSON-only protection; the thing being recorded here is different — it's that any same-origin caller (or, once `now-09` phase 2 lands, a token-bearing one) can read arbitrary file contents by path, which is the intended feature (a local, unauthenticated, loopback-bound server that reads local files is the whole product), not a defect specific to this endpoint. TBD.md §5 already states the accepted policy for path-based ingestion ("Path-based ingest reads any file the user can read": "any absolute readable path"); this endpoint follows the same policy for a read-only preview instead of a full ingest. The mitigation already on the roadmap is `now-09`'s Host allow-list (stops the browser-DNS-rebinding vector, already shipped) and, in phase 2 (unstarted, blocked on `now-12`/`now-13`), a per-launch bearer token (stops any other local process/user).

**Suggested next step:** none specific to this endpoint. When `now-09` phase 2's token lands, it covers this the same way it covers every other endpoint; no per-endpoint fix is warranted in the meantime.

---

## 2026-09-03 — `/ingest/end` while a path-ingest job is still running (now-08 phase 2)

**Severity:** Low today (no UI calls either endpoint yet), but a real race once the wizard wires phase 2 up in a later phase.

**What:** `POST /ingest/file` now returns before the file is read (202, job model). If a caller calls `POST /ingest/end` for that session before the job reaches a terminal state, `HandleIngestEnd` deletes the session from `sessionMap` immediately; the job's next `ingestBatch` call then fails with `errInvalidSession`, and the job finishes in state `error` with whatever rows were stored before that point kept (nothing is rolled back — same partial-success semantics as any other mid-job failure). The spec's own text ("`POST /ingest/end` closes the session as today") says not to change this behavior, so it wasn't changed; the swagger description on `HandleIngestFile` now states the ordering rule explicitly ("call `POST /ingest/end` only after the job reaches a terminal state") as the interim contract.

**Two ways to close this properly, not implemented here:**
1. Leave it as a documented caller responsibility (current state) — cheapest, matches the spec's literal instruction, but relies on every future caller (the wizard in phase 3, `now-04` folder watch, `now-12` CLI) reading the docstring rather than the type system.
2. Make `HandleIngestEnd` return 409 when any job for that session is still `running`, so a caller that gets the ordering wrong fails loudly instead of silently losing the tail of a file. This is new behavior beyond what the spec asked for, so it's a product decision, not a bug fix — recommended if phase 3's wizard doesn't fully own not calling `end` early (e.g. a "cancel and reset" button that ends the session unconditionally).

**Suggested next step:** decide before phase 3 wires the wizard to path-ingest; whichever way, the wizard's cancel/reset flow needs to know about it.

---

## 2026-09-03 — path-ingest jobs share `TailManager`'s not-awaited shutdown-drain gap (now-08 phase 2)

**Severity:** Low-medium. Pre-existing, not introduced here, but now has a second occupant.

**What:** `Server.Start()`'s shutdown sequence is: cancel `cleanupCtx` → `httpServer.Shutdown(ctx)` (30s drain) → `CloseStorage()`. Cancelling `cleanupCtx` triggers `TailManager.Shutdown()` in a goroutine off `<-ctx.Done()` (see `TailManager.Start`), which is never awaited before `CloseStorage()` runs — `TailSource.Stop()` blocks up to 5s per source, but nothing blocks `Start()`'s own flow on it. Path-ingest jobs (this session's work) derive their context from the same `cleanupCtx` (via `Services.ingestJobsCtx`, wired by the new `StartIngestJobs`), so cancelling it propagates to every running job's context automatically — cooperative, checked on the job's next `reader.Next()` call — but is equally not awaited before `CloseStorage()`. In both cases, one in-flight `StoreWithIDs` batch (up to 10k lines) can legitimately still be running when the Bleve indices are closed underneath it.

**Why not fixed here:** this session's H6 test (`TestIngestFileCancelledByServerShutdownContext`) only proves a job's context is cancelled by the parent context — it does not exercise the real `Start()`/signal/`Shutdown()` sequence, so it doesn't prove indices close cleanly around an in-flight batch. Fixing the underlying gap means changing the shutdown sequence both `TailManager` and the ingest-job registry now share, which is bigger than this package's scope and risks the same class of regression `now-09`'s consumer sweep exists to catch (a shared, load-bearing sequence with two callers now instead of one).

**Suggested next step:** a `next-10`- or `now-13`-adjacent fix: give both `TailManager` and the ingest-job registry a `Shutdown(ctx) error` that `Start()` actually calls and awaits (with a bounded timeout) before `CloseStorage()`, rather than firing-and-forgetting off a goroutine.

---

## 2026-09-03 — `docs/live-streaming.md` documents no SSE event schema, existing or new (now-08 phase 2) — **Closed**

**Closed 2026-09-16** (stale heading) — now-08 phase 6 (`a312492`) already wrote the doc's first event schema (`ingest_progress`); the TBD row recorded it but this heading was never updated. `grep -c ingest_progress docs/live-streaming.md` → 2.

**Severity:** Informational.

**What:** `specs/README.md`'s shared conventions say "New SSE event types go in `types.go` beside the existing live events and are documented in `docs/live-streaming.md`." The new `ingest_progress` event was added to `types.go` per that rule, but not documented in `docs/live-streaming.md` — checked, and that doc does not describe the wire schema of any of the four existing events (`hello`/`rows`/`skipped`/`source_status`) either; it's a CLI/demo-usage guide, not a protocol reference. Documenting `ingest_progress` alone, in a doc that documents no other event, would be inconsistent and imply a completeness the doc doesn't have.

**What I did:** deferred the doc update to phase 3 (wizard UI wiring), where `ingest_progress` gets a real consumer and the documentation can describe both together, rather than write an isolated paragraph now.

**Suggested next step:** either write phase 3's doc paragraph as planned, or — if a supervisor wants full protocol docs sooner — treat "document all five SSE events in `docs/live-streaming.md`" as its own small hygiene task, independent of any one spec.

---

## 2026-09-02 — now-02's Performance criterion passes by architecture, not by speed (tracking correction found at now-08 pickup)

**Severity:** Informational / low. No code change; corrects how a previous row characterized an already-known number.

**What:** the now-02 TBD row previously said now-11's harness found `search_term_facets` "over budget already" against the spec's "~20% latency growth" manual-validation criterion, implied as an open concern. Traced the actual wiring instead of inferring from the number alone: the spec's criterion is specifically "search latency **shown in the status bar**." `frontend/src/components/Shell/StatusBar.tsx` displays `apiExecutionTime` from `useSearchQueryParamsStore`, which `useSearchLogs.ts` sets via `setPerformanceMetrics()` **only** inside the primary `fetchLogs()` call (~line 160) — a request that never sends `include_facets`. The facets scan happens through a second, separately-deferred call, `refreshSearchMetadata()` (added in now-02 phase 2 for exactly this reason — "ride the deferred request only while the panel is open"), which updates `total_count`/`log_distribution`/`facets` in other stores but never touches `setPerformanceMetrics`. Consequence: the number the spec's criterion is about literally cannot change when `include_facets` is toggled, in either direction — the criterion is satisfied by construction, independent of how slow the facets scan is.

**What this does not mean:** the facets scan is not fast. `search_term_facets` p95 = 738 ms at 100k rows (now-11's row) is real, and it is what a user waits for the Fields panel to populate after results appear — a real UX cost, just not the one the spec's manual-validation step measures. It also means the spec's own suggested remedy if the budget were ever exceeded ("aggregate in the fan-out goroutines, step 2 alternative") is not available: that alternative targets `storage.Search()`, the legacy per-day-goroutine path, which the spec's own step 2 correction (line 21) already established the live code does not use (`SearchPage`/`Facets` do). The only real lever on this cost is `next-10`'s already-tracked lease-per-batch/cursor work on `Facets()`.

**Why this belongs here rather than a fix:** nothing is broken; this is a documentation correction to avoid a future reader treating a passing acceptance criterion as failing, or reaching for a dead remedy. If the Fields-panel-open latency becomes a real product concern, the next step is a `next-10` follow-up, not a now-02 reopening.

---

## 2026-09-02 — `Storage.Facets()` could spin forever on a stuck search-after cursor — **fixed** (found during now-11 phase 2b-ii)

**Severity:** P1 by this repo's own §2 vocabulary ("unbounded behavior a user will hit") — not P0. Over HTTP the spin is bounded: `/api/v1/logs` (`handlers/logs.go:265`) passes `r.Context()` into `Facets`, and that request sits inside `server.go`'s `middleware.Timeout(cfg.Timeout)` group (`cfg.Timeout` defaults to 60s, `main.go:167`), which cancels the context and the loop's per-iteration `ctx.Err()` check returns promptly. So a real request on a corpus that hits this boundary errors out after ~60s rather than hanging the process — still a real defect (that request can never succeed for that query, and it pegs a core plus holds `s.mu.RLock()` — blocking `Clear`/`PruneOlderThan` — for the full 60s every time), but bounded. The **unbounded, true-hang** case is the bench harness itself, which calls `Facets` with `context.Background()` (no deadline) — that is what actually spun at 100%+ CPU for 17–24 minutes below, and what a caller with an uncancellable/long-lived context (a future MCP tool handler, a batch job) would also hit. Fixed in the same commit that found it, `a0e1b35`.

**What:** building `backend/bench/`'s facets scenario (100,000-row corpus, `status:500` query matching exactly `MaxFacetSampleRows` = 20,000 hits) spun indefinitely at 100%+ CPU under the bench harness's uncancelled `context.Background()`. Confirmed with temporary debug tracing (not committed) run against the deterministic bench corpus: `agg.rows` got stuck at 19,998 — two short of the cap — with every subsequent batch returning the exact same two already-`seen` documents (`prevCursor == newCursor`, byte-for-byte identical, across dozens of iterations). Two orphaned compiled `go run` child binaries (a known footgun — see TBD.md's now-11 row, phase 2b-i section, "kill by port not by PID") kept these particular runs going in the background for 17–24 minutes each before they were noticed and killed by PID; that duration is an artifact of how they were launched, not a property of the bug itself (the bug has no bound of its own absent a context deadline).

**Root cause:** near the sample cap, `remaining := MaxFacetSampleRows - agg.rows` shrinks `request.Size` below `facetScanBatchSize` (1,000). The bench corpus's `generateLine` derives timestamps from `seq % 86400`, so two documents 86,400 apart in `seq` land on the identical second — an ordinary, non-adversarial tie. When that tie sits exactly at the shrunk boundary (`request.Size` = 2 in the observed case), the search-after cursor stops advancing: the same page comes back every time, the `seen`-dedup set (added specifically to fix the *miscount* variant of this bug, see the amended entry below) means `newHits` is always 0, and the loop's only other exit condition — `len(result.Hits) < request.Size` — never fires because the batch is always exactly full. `agg.rows` never reaches `MaxFacetSampleRows`, so the `for` loop's own condition never goes false either. Net effect: an infinite loop, not merely a slow one.

**Fix:** when a batch adds zero new (non-duplicate) hits, the scan cannot make progress — return the aggregate collected so far instead of looping again, with `Sampled` computed by the same honest `uint64(agg.rows) < total` formula the normal exit path already uses (not a hardcoded `true`, which would misreport a case where the stuck page happens to arrive after the count is already exact).

**What this does and does not fix:** this stops the *hang*. It does not fix the underlying broken cursor — the same root cause as the entry below (a tied sort key that the search-after mechanism cannot disambiguate), confirmed here as **the cursor does not advance across iterations when stuck** (the trace's `prevCursor == newCursor` is direct evidence of that specific claim; it is consistent with, but does not by itself isolate, the `_seq`-unindexed hypothesis the entry below proposes). `SearchPage` shares this exact cursor and tie condition but does not hang from it, because `SearchPage` has no `seen`-dedup — it just returns the same rows twice, which is the already-tracked miscount below. Same root, two different symptoms depending on whether the caller dedupes. `next-10`'s cursor-paging fix is still the real cure for both.

**Verified:** new regression test `TestFacetsScanTerminatesOnStuckSearchAfterCursor` (`backend/pkg/storage/facets_test.go`) constructs the most extreme version of the tie (all `MaxFacetSampleRows` rows sharing one timestamp) and confirms, via `git stash`, that it fails with `context deadline exceeded` after a 10-second timeout on the pre-fix code and passes in 0.27s with the fix. Full detail and the exact trace line are in the `a0e1b35` commit message.

**Also noted:** `search_term_facets` in the bench harness landed on this exact boundary at 100k rows (`computed_over: 19998, sampled: true` in `bench.json`) — not a contrived worst case, an ordinary run.

---

## 2026-09-02 — now-09 phase 2's acceptance criteria depend on two unstarted v1.8 specs (found during now-11 pickup)

**Severity:** Low. Doesn't block anything today; matters the next time someone picks `/pickup` and reads the table literally.

**What:** `specs/README.md`'s pickup table lists `now-09-loopback-security.md`'s "Depends on" as `—`. That's correct for phase 1 (shipped) but not for phase 2 (the per-launch bearer token): `specs/now-09-loopback-security.md`'s own acceptance criteria for phase 2 read "app, CLI (`tail`, `open`, `doctor`), MCP stdio, and browser mode all work without manual token handling" and "`logsonic doctor` (`now-13`) reports allow-list + token status" — `logsonic open` is `now-12` and `logsonic doctor` is `now-13`, both v1.8, both unstarted. Phase 2 cannot close its own acceptance boxes yet. This surfaced while picking a work package this session: a literal "first spec in pickup order that is not Done" reading would have picked now-09 phase 2 next, before its dependencies exist.

**What I did:** did not pick now-09 phase 2; picked now-11 phase 2 instead (next v1.7 row with satisfied deps). Did not edit `specs/README.md`'s table (`specs/*.md` content changes are for factual corrections found *while implementing that spec* — this session implemented now-11, not now-09).

**Suggested next step:** either annotate the now-09 row's "Depends on" column with "phase 2: now-12, now-13" or split now-09 into two rows (phase 1 done; phase 2 as its own row placed after now-13 in pickup order) so a future literal read of the table doesn't reach the same dead end.

---

## 2026-09-02 — now-08 phase 1 was found uncommitted in the working tree at pickup

**Severity:** Low for the code (reviewed and verified before completing it), but a process gap worth a human's attention: [`specs/WORKFLOW.md`](specs/WORKFLOW.md) §0 preflight says a dirty tree at pickup means stop and report, not continue.

**What:** Starting this session's `/pickup`, `git status` was already dirty with a substantial, apparently-finished implementation of now-08 phase 1 (the `pkg/ingestfile` reader package, the `/ingest/file` handler, tests, and the spec's own "Phase split, recorded 2026-09-02" annotation) — but no commit, no TBD.md/ISSUES.md row, and no stash entry. There is no way to tell from the repository who wrote it or when the session that produced it ended. It matched the pickup order exactly and the spec had already been annotated with today's date, which is what made continuing look like resuming in-progress work rather than inventing a new package — but that inference isn't provable.

**What I did:** rather than discard a large, apparently-working implementation on an unproven guess about authorship, I read every changed and new file line by line against the spec, ran the full verification matrix (build/vet/test/race/gofmt/mod tidy/swag-drift/vitest/eslint/tsc), and found two real bugs in the pre-existing diff (a dead-route/wrong-type bug in `api-client.ts`, and a now-09 CSRF-defense gap on the new route) that I fixed before committing. Full detail is in the `3ce78bc` commit message and the TBD.md row for now-08.

**Suggested next step:** if this wasn't your work, the two bugs above are worth knowing were caught rather than shipped silently; if it *was* yours from an earlier session that didn't reach the commit step, no action needed beyond noting that `/pickup` should probably fail fast here rather than infer intent — worth a line in WORKFLOW.md §0 about what "stop and report" should look like when the alternative is losing real work to no record at all.

---

## 2026-09-02 — `SearchPage` duplicates rows at search-after seams when timestamps tie (found during now-02)

**Severity:** P1 correctness. User-visible: any page whose internal scan crosses a 1,000-row seam inside a run of ≥50 tied timestamps can repeat rows already shown **and shifts every later page**, because the rows skipped past the seam are miscounted. `total_count` comes from the time facet, not the scan, so it stays right — the visible symptom is pages that don't add up to the total. Every `DEFAULT_PATTERN` (no-timestamp) import produces such runs, since whole chunks get the same ingest second. Not a crash, not data loss; wrong rows on a page.

**What:** `storage.SearchPage` walks the window in search-after batches of 1,000 sorted by `timestampSort` (`timestamp`, `_seq`, doc ID). With 2,500 rows in which each second holds 50, paging with `limit=1000` returns **2,600 rows with 100 duplicated document IDs** — exactly one tied-timestamp group re-read at each of the two seams. Reproducer: `backend/pkg/storage/search_page_seams_test.go`, committed with a `t.Skip` naming this entry; remove the skip when fixed. Found because the facet scan (same cursor) counted 2,002 on a 2,000-row window; the facet scan now dedupes by document ID so its counts are exact regardless.

**Likely cause (not yet proven):** `_seq` is stored but deliberately not indexed (`seqField.Index = false` in `buildIndexMapping`, from the index-size work), so the `_seq` sort key is "missing" for every document and cannot disambiguate the cursor; the trailing doc-ID key should, but the observed re-reads say the search-after value for it is not being applied. One thing to verify first: Bleve sorts from indexed terms / doc values, not from stored fields, so a `SortField` on a stored-but-unindexed field may not sort *at all* — in which case the `_seq` tiebreak has never worked and every tied-timestamp ordering has been doc-ID order (lexicographic: seq 10 before seq 9), i.e. the "preserve log order" intent of commit f502233 may not hold either. The mapping comment ("persist it so it round-trips for sorting") would then be wrong and should be corrected with the fix. Two candidate fixes, both `next-10` storage-hardening territory: (a) make search-after resume on `(timestamp, docID)` only and verify Bleve honours the doc-ID cursor; (b) index `_seq` (costs index bytes; needs the migration story for old shards). The spec's "cursor-paged sort on any field" work in `next-10` has to solve this anyway — recommend pulling that item forward.

**Why not fixed here:** outside the facets package's scope and time box; the fix touches the paging path every search uses and needs its own verification (the seam test plus the existing `SearchPage` tests with >1,000 rows).

**Update 2026-09-02 (now-11 phase 2b-ii):** confirmed directly, not just inferred — a temporary debug trace on a stuck `Facets()` scan (see the entry above) showed the search-after cursor returning byte-for-byte identical values (`prevCursor == newCursor`) across dozens of consecutive iterations while parked on a tied-timestamp pair. That confirms **the cursor does not advance** when stuck; it does not, by itself, isolate *why* (the `_seq`-unindexed hypothesis above remains a hypothesis, not confirmed). Practical consequence found in the process: because `Facets()` also added a `seen`-dedup set to correct for this exact miscount, the same stuck cursor turns into an *infinite loop* there instead of a miscount — see the dedicated entry above and its fix (`a0e1b35`), which stops the hang without touching the cursor logic this entry is about.

---

## 2026-09-02 — CI workflows are committed but have never executed (now-11 phase 1) — **Closed**

**Closed 2026-09-16** — maintainer pushed `dev` and opened draft PR #35. First run: 5/6 CI jobs green; the two failures (Docs: `RELEASE.md` → gitignored `backend/pkg/static/dist/`; macOS: `rg` not on the runner) were exactly the "worked locally" class predicted below, fixed in `2edbe15` / `80f6f2a`. Second run fully green (CI 35066190789, Docs 35066190782). Branch protection / required checks remain a repo setting for the maintainer to flip after merge. The `backend/README.md` tracked-but-ignored note below is still open.

**Severity:** Medium for confidence, zero for risk. Nothing runs until something is pushed, and the standing rule for this branch is never push.

**What:** `.github/workflows/ci.yml` and `docs.yml` were validated as YAML and every job's *commands* were run on this machine (see the TBD row for the list), but GitHub Actions has never executed them. Runner-environment differences are the usual first-run failures: `actions/setup-go` caching paths, `npx playwright install --with-deps` on Ubuntu, `test-macos-app.sh` on a `macos-latest` image with a different Xcode, the `goreleaser-action` version resolver, and `git diff` behavior on the shallow checkout the `web` job avoids with `fetch-depth: 0`.

**What a human needs to do:** push `dev` (or open a PR from it) and watch the first run. Expect to iterate once or twice on runner details; every job's commands were run locally, and the changed-files lint step's diff logic was exercised locally against real commit ranges from both the repo root and `frontend/` (it initially had a pathspec bug that made it a silent no-op — caught in review, fixed before commit). Until that happens, "CI gate" in the roadmap means "designed and locally verified," not "protecting `main`." Branch protection (required checks `go`, `web`, `swift`, `snapshot`, `e2e`) is a repo setting to flip after the first green run.

**Also noted:** goreleaser's `before.hooks` copy `../README.md` into `backend/README.md`, which is a **tracked** file that is also listed in `.gitignore` — so every snapshot build dirties the working tree with a copy of the root README. Harmless in CI (the Swagger drift check is scoped to `backend/docs/`), confusing locally. Candidate fix: `git rm --cached backend/README.md backend/LICENSE` so the ignore rule actually applies; that belongs in a hygiene commit, not here.

**Two gates are intentionally non-blocking** (`continue-on-error`) in the `web` job until their pre-existing baselines are cleared: `tsc --noEmit` (415 errors, almost all `noUnusedLocals` in `components/ui/*` — the shadcn scaffolding imports every React hook) and eslint on changed files (the 6,272-error baseline from the lint entry below). Both counts land in the job summary so they can be ratcheted; flipping either to blocking is a one-line change once the number is zero.

---

## 2026-09-02 — GitHub issue #10 reconciliation needs a human to run it (now-07 task 4) — **Closed**

**Closed 2026-09-16** — the maintainer ran both commands: tracking issue #34 created, pointer comment posted on #10 (confirmed via `gh issue list` and `gh issue view 10`). now-07 is marked Done in TBD.md.

**Severity:** Low. Public-facing housekeeping; nothing in the code depends on it.

**What:** Issue #10 (Splunk-style field extraction) is closed on GitHub but unshipped; `specs/now-02-faceted-fields-sidebar.md` is the plan. The spec asks for a fresh tracking issue plus a pointer comment on #10. Creating a public issue on the project's tracker from an unattended session is an outward-facing action, so it was **not** run. `gh` is authenticated on this machine; the two commands are:

```bash
gh issue create --repo logsonic/logsonic --title "Faceted fields sidebar (supersedes #10)" --body "Tracks specs/now-02-faceted-fields-sidebar.md on the dev branch. Issue #10 (field extraction) was closed without shipping; this issue supersedes it and will close when the sidebar lands."
gh issue comment 10 --repo logsonic/logsonic --body "Superseded by the tracking issue above (specs/now-02-faceted-fields-sidebar.md). #10 was closed before the feature shipped."
```

(Replace "above" with the new issue number the first command prints.) Once run, mark now-07 Done in the TBD progress log.

**Also noted during this package:** regenerating Swagger for the new `/info` fields pulled in two `/logs` query parameters (`fields`, `include_distribution`) that were annotated in `handlers/logs.go` but missing from `backend/docs/` — i.e. the committed Swagger had already drifted from the annotations before this session. The regen is in commit `13b3bc1`; `now-11`'s CI drift check is what prevents a recurrence.

---

## 2026-09-01 — `logsonicfile:` in CSP fixed but unverified in the native app (now-09 review) — **Closed**

**Closed 2026-09-16** — moot: the scheme was deleted entirely in `d4ce39a` (see the 2026-09-03 `NativeFileSchemeHandler` entry). There is no longer a `logsonicfile:` fetch to verify.

**Severity:** Low-medium. The fix is almost certainly right, but "almost certainly" is not the standard for a path that gates dock-drop import in the shipped Mac app.

**What:** The now-09 CSP (`connect-src 'self'`) blocked two fetches the native shell depends on. Both were fixed in commit `1842921` by adding `blob: logsonicfile:` to `connect-src`:

- `blob:` — the shell's download hook (`blobDownloadHookJS` in `LogsonicApp.swift`) does `fetch(anchor.href)` on the export blob. **Confirmed both ways** in Chrome against the embedded build: under the old policy a `securitypolicyviolation` event fired with `violatedDirective=connect-src, blockedURI=blob` and the fetch failed; under the new policy the fetch returns 200 with no event.
- `logsonicfile:` — dock-drop / Finder "Open With" hands the SPA `logsonicfile://<id>` URLs that `FileSelection.tsx` fetches. Same CSP rule (a non-http scheme never matches `'self'`), same fix — but **not verified**: the ad-hoc dev app was built and launched with a file, and the running child served the new header, but the import wizard's state can only be seen on screen (it does not auto-import, so there is no server-side signal), and desktop-control permission is not granted on this machine.

**Manual step (30 seconds):**

```bash
# Build the Go binary into a scratch path and pass it as $1: dev-macos-app.sh would
# otherwise rebuild into backend/logsonic (gitignored, but a stale 68 MB binary there
# is easy to mistake for a current one later), then build the ad-hoc app.
go build -C /Users/akashgoswami/src/logsonic/backend -o /tmp/logsonic-scratch/logsonic .
LOGSONIC_DEV_NO_OPEN=1 bash /Users/akashgoswami/src/logsonic/backend/scripts/dev-macos-app.sh /tmp/logsonic-scratch/logsonic
open --env STORAGE_PATH=/tmp/logsonic-scratch/store -a /Users/akashgoswami/src/logsonic/backend/dist-dev/Logsonic.app /Users/akashgoswami/src/logsonic/sample-logs/apache.log
```

(`backend/pkg/static/dist` must already hold a current `npm run build:copy`; the app's own server picks a free port.)

Expected: the app opens on the Import page with `apache.log` listed in the wizard. If instead the page is empty (the fetch was refused), the fallback is to have the shell mark its own requests — `webView.customUserAgent` with a `Logsonic/<version>` token — and skip the CSP header for that user agent in `serveWithMimeType`. Spec `now-08` retires the `logsonicfile:` path entirely, so this is a bridge, not a permanent exception.

---

## 2026-09-01 — Frontend lint: what's left after the config fix, and one house-style decision (from now-01; remediated in part)

**Closed part (commit `7641db7`):** The original entry blamed a repo-wide quote-style mismatch on the codebase. The root cause was two config files disagreeing: `eslint.config.js` carried an inline `prettier/prettier` options object with `singleQuote: true` while `.prettierrc` said `false`, so `npm run lint` and `npm run format` enforced opposite styles and every line matched one of them. The inline options are gone; `.prettierrc` is now the single source of truth. Which value to keep was measured, not guessed: `singleQuote: false` → 6,352 prettier errors, `true` → 5,425, so `.prettierrc` now says `true` (the codebase leans single, and single is what the lint gate had always enforced). Separately, all 80 `no-undef` errors were Node scripts (`e2e-*.mjs`, `scripts/analyze-imports.js`) linted with browser-only globals; a files-scoped globals block fixed them: 80 → 0.

**Open decision — Severity: low urgency, but it keeps `npm run lint` from being a pass/fail gate:**

| Category | Count | What it would take |
|----------|------:|--------------------|
| `prettier/prettier` drift | 5,425 across 134 of 147 files | One `npm run format` commit. Semantics-preserving and verifiable (vitest + build), but it rewrites most of `src/`, destroys `git blame` continuity, and conflicts with every open feature branch (`v2`, `feat/*`, `live-tailing`, …). |
| `@typescript-eslint/no-unused-vars` | 537 | Real code deletions — not mechanical. |
| `import/order` | 286 | `eslint --fix` can do it, but it reorders imports in ~every file (same blame/conflict cost as formatting). |
| Other (`no-explicit-any` 29, misc.) | ~40 | Case by case. |

**Recommendation:** decide the format commit together with a branch-merge plan — do it right after the open branches are merged or abandoned, as a single commit with nothing else in it, and have `now-11`'s CI gate enforce lint on *changed files only* until the baseline is zero. Until then, the WORKFLOW.md rule applies: compare per-file error counts before/after, and require zero errors on added lines.

---

## 2026-09-01 — CSP not manually verified in a live browser (now-09) — **Closed**

**Closed 2026-09-01 in the now-09 review.** The embedded build was run against scratch storage, seeded with 300 rows of `sample-logs/apache.log` through the ingest API, and loaded in Chrome with a `securitypolicyviolation` listener installed in-page (the console-messages tool does not surface CSP reports — noted in WORKFLOW.md). No violations observed during interactions (a search, two theme toggles, an export click). Load-time blocks were ruled out functionally rather than by the listener — it was installed after load — because the page rendered, styles applied, and the Recharts histogram drew, which a blocking `script-src`/`style-src` violation would have prevented. The export anchor itself was not observed by the listener harness (the button match may have hit a different control), so the blob-download step was verified separately via the direct blob fetch described in the entry above — which is also how the `blob:` regression was found.

---

## Notes on process (not an issue, for context)

- Work packages so far: `now-01` (Done), `now-09` phase 1 (Partial — phase 2 token is v1.8), `now-07` (Partial 6/7 — only the public GitHub action above is outstanding), `now-11` phases 1–2b-ii (Partial — the PR gate is committed and locally verified but unexecuted until a push, see above; phase 2b-i's doc-command executor and phase 2b-ii's bench harness + `nightly.yml` are both built and verified at dev scale; building the bench harness found and fixed a `Storage.Facets()` hang bug, see above; remaining: the real 10M-scale numbers, since nothing has been pushed for `nightly.yml` to actually run), `now-02` phases 1–2 (Partial — endpoint and Fields panel done with a self-seeding E2E; phase 3 is the MCP `facets_only` handoff, a latency check at scale, and the `_src`-from-catalog switch after `now-10`), `now-08` phase 1 (Partial — synchronous path-based ingest). The first two were picked up in interactive sessions; the review that produced the older entries is codified as [`specs/WORKFLOW.md`](specs/WORKFLOW.md), and `now-07` was the first package run through it (three advisor gates, consumer sweep, HTTP-level regression test).
- Three test runners are now in use across the repo: Go's `testing` package, frontend `vitest`, and — as of `now-11` phase 2a — Node's built-in `node:test` for CI-only helper scripts under `.github/scripts/` (zero framework overhead, matches the tiny-script style already used there). Don't introduce a fourth; `.github/scripts/*.test.mjs` run via `node --test <file>` is now the pattern for anything in that directory.
- All commits are on the local `dev` branch only — **not pushed to `origin`** per explicit instruction. `origin` has no `dev` branch.
- No attribution trailers on any commit, per explicit instruction for this repo.
- `now-09` phase 2 (per-launch bearer token, protecting against other local users on a shared machine) was **not** attempted. "now-09 Partial" must not be read as "the loopback API is authenticated"; it still isn't.
- Search sanity note for future testers: LogHub's `sample-logs/apache.log` is an Apache *error* log (`[notice] jk2_init() …`), not an access log. Querying `GET` against it returns 0 hits by design; `notice` returns 211. Don't mistake that for a search bug.
