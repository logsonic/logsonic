# Issues for supervisor review

Findings that need a human decision, or are worth knowing about, surfaced while implementing roadmap work. **Open items** need a decision or a fix. **Resolved** is a compact log of what was found and fixed, kept for the trail. Full forensic detail for any entry (root cause, exact commits, verification steps) is in git history and commit messages — this file is deliberately a summary.

---

## Open items

### v1.7.0 macOS build is Apple Silicon (arm64) only for now (2026-09-24)
The v1.7.0 release build failed to link the x86_64 half of the universal macOS app: the installed Command Line Tools (27.0) no longer ship x86_64 Swift compatibility libraries (`libswiftCompatibility56`, `libswiftCompatibilityConcurrency`), so `swiftc -target x86_64-apple-macos11` fails at link time. Decision made: drop Intel from this release rather than block it — `backend/.goreleaser.yaml`, `backend/scripts/app-macos.sh`, and `backend/scripts/release.sh` now build/sign/notarize an arm64-only `Logsonic.app` (no more `lipo`/universal binary). Re-adding Intel support needs either an older Xcode/CLT with x86_64 Swift libs, or waiting on Apple's toolchain. The Go binary itself is unaffected (`goos: darwin, goarch: [arm64]` only — was already cross-compiled, no toolchain dependency there).

### A theme-notification bug fix is sitting uncommitted, waiting on a decision (2026-09-24)
Someone (unclear who) fixed a real bug and left it unstaged in the working tree: the app was calling a `window.__logsonicNotifyTheme` function that was never actually defined anywhere, so clicking the theme toggle silently failed to repaint the native window background (only OS-driven theme changes worked, through a separate path). The fix posts to the correct native message channel (`webkit.messageHandlers.logsonicTheme`) instead. Touches `frontend/src/lib/native.ts`, `frontend/src/stores/useThemeStore.ts`, and its test. All tests pass with the fix in place. Left out of the synonym-search commit since it's an unrelated change — needs a decision to commit it (as its own commit) or drop it.

### Import UI redesign: deliberate deviations from the design handoff (2026-09-19)
Product/UX calls made while shipping the single-surface import page — each is the maintainer's to overturn, none blocks the shipped flow:
- Topbar uses the app's own theme tokens, not the prototype's hardcoded colors (keeps dark mode consistent; not yet watched live in the native app).
- Smart decoder defaults on, though the handoff spec said off — kept to match existing behavior.
- The save-pattern dialog still fires before import, not after, matching the old wizard's blocking behavior.
- The "MM/DD vs DD/MM" ambiguous-timestamp buttons aren't wired up — needs backend work in `timeresolve` to expose the competing formats.
- Per-file pattern match-% scores are computed lazily on first view (~1–2s), not instantly.
- Native empty-state copy differs from the handoff wording since window drag-and-drop isn't built yet (see next item).
- The store still keeps a few legacy single-file fields that `SavePatternDialog` / `FileSelectionService` depend on.
- `frontend/e2e-bgl-import.mjs` is stale and not in the CI run — needs rewriting against the new import surface.

### Dropping a file on the app window does nothing (2026-09-07, scheduled for macos-b3)
Only the Dock icon and Finder "Open With" trigger an import — dragging a file onto the open app window is silently swallowed, at both the AppKit and web layers. The fix is already designed in `specs/macos-b3-ambient-presence.md`; nothing implemented yet.

### Two watched folders with the same directory name collide (2026-09-16, now-04)
A watched file's source name is `watch.<dirname>.<filename>`, so two different directories sharing a name (e.g. two `logs/app.log`) produce the same source name and silently overwrite each other's rows. Watching the *same* directory twice is already blocked; the general case needs a naming decision (e.g. embed a short watch ID) before phase 2.

### "Reveal in Finder" hasn't been clicked live in the native app (2026-09-16, now-10)
Code compiles and is wired up correctly, but no desktop-control session has verified it opens Finder. Manual check: Settings → Storage → Reveal in Finder in a built `Logsonic.app`.

### `-retention-days 0` doesn't mean "keep everything" (2026-09-16, now-10)
The CLI flag can't distinguish "not passed" from "passed 0", so `0` silently falls back to the `RETENTION_DAYS` env var. `config.json`'s `retention_days: 0` already provides a real off-switch. Fixing the flag needs a sentinel default — worth it only if the maintainer wants that CLI semantics change.

### `_src` is still tokenized (not exact) on shards created before now-10 (2026-09-16)
New day-indices map `_src` as an exact keyword field; older shards still run it through the text tokenizer, so source filters and future deletes on old data can be inexact until phase 2 adds an exact-match fallback there, or the shard is reindexed.

### Catalog counts can be off by one batch during a concurrent import (2026-09-16, now-10)
A microsecond race between a batch commit and a concurrent rebuild can double-count a batch; the next rebuild self-corrects. Not fixed because a real fix means serializing ingest behind one lock or adding a generation counter — bigger than this phase's scope.

### Per-source delete has two known blind spots (2026-09-16, now-10)
(a) A browser upload in progress isn't visible to the delete's in-use check, so its next chunk can land after a delete (mitigated in the UI by disabling delete/re-import while uploading). (b) Rows on a catalog day missed before the unclean-exit fix could survive a delete; `POST /sources/rebuild` is the intended remedy.

### `e2e-comprehensive.mjs`'s "import redirects to home" check is flaky (2026-09-03)
Reads the search input before the home view finishes mounting; fails deterministically on this machine, reproduces on a clean `dev` checkout with no other changes. Needs a proper wait — not owned by any current work package.

### Large single-file imports exceed their memory budget (2026-09-03, now-08 H5)
A 200MB / 1.65M-line import peaks around 320MB heap against a 150MB target. Traced to bursty memory in Bleve's background segment-merge cycle, not the ingest reader (which is confirmed bounded). Needs a storage-engine investigation before choosing a fix — shrinking the write batch size could make merge pressure worse, not better.

### `/parse/preview-file` reads any path with no session required (2026-09-03, now-08)
Same class of exposure as this server's other local-file endpoints, and accepted as by-design for a local, loopback-only tool. Will be closed by now-09 phase 2's per-launch bearer token (unstarted; blocked on `now-12`/`now-13`). No endpoint-specific fix planned before then.

### Ending a session mid-import can silently drop rows (2026-09-03, now-08)
Calling `POST /ingest/end` while its path-ingest job is still running kills the job with no rollback of what's already stored. Needs a decision before phase 3 wires the wizard to this path: document it as a caller responsibility (current state), or make `/ingest/end` return 409 while a job is running.

### Server shutdown doesn't wait for in-flight ingest batches (2026-09-03, shared with `TailManager`)
Shutdown can close storage indices while a batch (up to 10k lines) is still being written, for both live tails and path-ingest jobs. Needs a real, awaited `Shutdown(ctx)` on both subsystems before storage closes — pre-existing gap, now has a second occupant.

### now-09 phase 2 can't close out until two unstarted specs land (2026-09-02)
The bearer-token phase's own acceptance criteria reference `logsonic open` (`now-12`) and `logsonic doctor` (`now-13`), both unstarted. Just needs `specs/README.md`'s dependency column annotated so it isn't picked prematurely.

### Search pages can repeat or skip rows when many rows share a timestamp (2026-09-02) — P1 correctness
Any page whose 1,000-row scan window crosses a run of ≥50 tied timestamps can show duplicate rows and shift every later page. Suspected cause: `_seq` is stored but not indexed, so it can't break the sort tie. Belongs with the planned cursor-based-paging storage hardening work.

### Frontend lint isn't a clean pass/fail gate yet (2026-09-01)
~5,425 formatting errors, ~537 unused-var errors, and ~286 import-order errors remain from before the lint config itself was fixed. Recommended: one dedicated `npm run format` commit once other open branches are merged, with CI enforcing lint on changed files only until the backlog clears.

---

## Resolved

- **2026-09-22** — Import redesign: one file's multiline header was silently applied to a whole batch, folding unrelated files. Fixed — multiline settings are now per-file.
- **2026-09-16** — Rows sharing a timestamp could sort out of order. Fixed for new rows (`c8bde0b`); rows written before the fix can still tie-break inconsistently against new ones within the same second.
- **2026-09-16** — A saved pattern's name alone was rejected by `/ingest/start` and `tail --pattern`. Fixed (`37ae9e0`).
- **2026-09-16** — The API's `details` error field was never read by the frontend. Fixed (`0317098`).
- **2026-09-16** — An unclean exit could silently lag the sources catalog. Fixed with a dirty-marker rebuild (`b3c1b6f`).
- **2026-09-16** — `specs/WORKFLOW.md` pointed at a deleted native-file scheme handler. Fixed.
- **2026-09-16** — Percent-encoded source names 404'd on `/sources/{name}`. Fixed (`d583e80`).
- **2026-09-16** — Re-importing the same lines double-counted rows in the catalog. Fixed (`49ee993`, `58a693f`).
- **2026-09-16** — Boundary pass (88 checks against the built binary): found and fixed the two items above; also documented three known, non-blocking behaviors — `pattern: auto` never rejects garbage input, any string is a valid source name (no length cap), and catalog reconcile is slower on shards created before now-10.
- **2026-09-07** — macOS M1–M10 manual UI checks walked live: all pass. Two real defects found and fixed along the way (dark-launch flash, traffic-light overlap — `3a843ad`).
- **2026-09-03** — Playwright locators for the search input and workspace menu broke once focused/loaded. Fixed with stable `aria-label`s.
- **2026-09-03** — Deleting a workspace leaked its saved queries into the next one saved. Fixed.
- **2026-09-03** — A new E2E check left DOM residue that broke the next check. Fixed by giving it its own browser page.
- **2026-09-03** — Native Dock-drop import of files >512MB. Verified live — works, old size cap is gone.
- **2026-09-03** — `NativeFileSchemeHandler` had no live caller in either app mode. Deleted as dead code.
- **2026-09-02** — `Storage.Facets()` could spin forever on a stuck pagination cursor. Fixed (`a0e1b35`).
- **2026-09-02** — CI workflows were committed but had never executed. Fixed — `dev` pushed, draft PR #35 is green.
- **2026-09-02** — GitHub issue #10 needed manual reconciliation. Done — tracked as issue #34.
- **2026-09-01** — `logsonicfile:` CSP scheme handling. Moot — the scheme was deleted entirely.
- **2026-09-01** — CSP had not been verified in a live browser. Verified — no violations observed.

---

## Notes on process

- All commits happen on `dev`; `dev` is pushed to `origin` and tracked by draft PR #35 (the CI vehicle) with the maintainer's authorization. No attribution trailers on commits, per standing instruction for this repo.
- Three test runners are in use: Go's `testing`, frontend `vitest`, and Node's built-in `node:test` for CI-only helper scripts under `.github/scripts/`. Don't add a fourth.
- `now-09` phase 2 (per-launch bearer token) has not been attempted — the loopback API is still unauthenticated.
- Search sanity note for testers: `sample-logs/apache.log` is an Apache *error* log, not an access log — querying `GET` against it returns 0 hits by design; `notice` returns 211.
