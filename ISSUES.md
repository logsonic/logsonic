# Issues for supervisor review

Findings surfaced while implementing roadmap work packages that need a human decision, or that are worth knowing about even though they didn't block the work in question. Newest first. Each entry names the work package it came from and its severity from the implementer's perspective — **not** a claim about how urgent it actually is; that's the supervisor's call. Entries that were remediated stay here, marked **Closed**, so the trail is visible.

Process: every candidate entry goes through the remediation pass in [`specs/WORKFLOW.md`](specs/WORKFLOW.md) §5 first (root-cause with a 10-minute budget, measure before choosing, classify fixable-in-scope / fixable-safe / needs-human). Only the third class lands here as an open item.

---

## 2026-09-02 — GitHub issue #10 reconciliation needs a human to run it (now-07 task 4)

**Severity:** Low. Public-facing housekeeping; nothing in the code depends on it.

**What:** Issue #10 (Splunk-style field extraction) is closed on GitHub but unshipped; `specs/now-02-faceted-fields-sidebar.md` is the plan. The spec asks for a fresh tracking issue plus a pointer comment on #10. Creating a public issue on the project's tracker from an unattended session is an outward-facing action, so it was **not** run. `gh` is authenticated on this machine; the two commands are:

```bash
gh issue create --repo logsonic/logsonic --title "Faceted fields sidebar (supersedes #10)" --body "Tracks specs/now-02-faceted-fields-sidebar.md on the dev branch. Issue #10 (field extraction) was closed without shipping; this issue supersedes it and will close when the sidebar lands."
gh issue comment 10 --repo logsonic/logsonic --body "Superseded by the tracking issue above (specs/now-02-faceted-fields-sidebar.md). #10 was closed before the feature shipped."
```

(Replace "above" with the new issue number the first command prints.) Once run, mark now-07 Done in the TBD progress log.

**Also noted during this package:** regenerating Swagger for the new `/info` fields pulled in two `/logs` query parameters (`fields`, `include_distribution`) that were annotated in `handlers/logs.go` but missing from `backend/docs/` — i.e. the committed Swagger had already drifted from the annotations before this session. The regen is in commit `13b3bc1`; `now-11`'s CI drift check is what prevents a recurrence.

---

## 2026-09-01 — `logsonicfile:` in CSP fixed but unverified in the native app (now-09 review)

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

- Work packages so far: `now-01` (Done), `now-09` phase 1 (Partial — phase 2 token is v1.8), `now-07` (Partial 6/7 — only the public GitHub action above is outstanding). The first two were picked up in interactive sessions; the review that produced the older entries is codified as [`specs/WORKFLOW.md`](specs/WORKFLOW.md), and `now-07` was the first package run through it (three advisor gates, consumer sweep, HTTP-level regression test).
- All commits are on the local `dev` branch only — **not pushed to `origin`** per explicit instruction. `origin` has no `dev` branch.
- No attribution trailers on any commit, per explicit instruction for this repo.
- `now-09` phase 2 (per-launch bearer token, protecting against other local users on a shared machine) was **not** attempted. "now-09 Partial" must not be read as "the loopback API is authenticated"; it still isn't.
- Search sanity note for future testers: LogHub's `sample-logs/apache.log` is an Apache *error* log (`[notice] jk2_init() …`), not an access log. Querying `GET` against it returns 0 hits by design; `notice` returns 211. Don't mistake that for a search bug.
