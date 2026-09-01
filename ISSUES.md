# Issues for supervisor review

Findings surfaced while implementing roadmap work packages that need a human decision, or that are worth knowing about even though they didn't block the work in question. Newest first. Each entry names the work package it came from and its severity from the implementer's perspective — **not** a claim about how urgent it actually is; that's the supervisor's call.

---

## 2026-09-01 — Repo-wide eslint/prettier quote-style mismatch (found during now-01)

**Severity:** Low urgency, but blocks `npm run lint` as a usable pass/fail gate for every future work package.

**What:** `npm run lint` currently reports **6,355 errors** across the frontend, the overwhelming majority of them `prettier/prettier` "replace double quotes with single quotes" on lines I never touched (`vite.config.ts`, `vitest.config.ts`, most of `tailwind.config.ts`, and almost certainly the rest of `src/`, based on the density in `tailwind.config.ts` alone — 1 error roughly every 1–2 lines).

**Why it matters:** The project's own eslint config (via the `prettier/prettier` rule) wants single-quoted strings; the codebase overwhelmingly uses double quotes. That means either the eslint config is wrong for this codebase's actual convention, or the codebase has never been run through `--fix` since prettier was added. Either way, `npm run lint` cannot currently distinguish "this PR introduced a real problem" from "this file has always looked like this" — every future spec's lint step will show thousands of pre-existing failures alongside anything genuinely new.

**What I did:** Verified my own three changed files (`index.html`, `frontend/src/index.css`, `tailwind.config.ts`) are lint-clean on every line I touched — confirmed by running eslint scoped to `tailwind.config.ts` and diffing which line numbers still error before/after my edit. I did **not** run `eslint --fix` repo-wide, since that would silently rewrite ~6,000 lines across files unrelated to the font work and make this PR unreviewable.

**Suggested next step:** Either (a) run `eslint --fix` (or `prettier --write`) across the repo as its own dedicated commit with nothing else in it, or (b) change the prettier config to `singleQuote: false` if double quotes are the intended house style. Either fix is out of scope for any single roadmap item — it's infrastructure, not a feature. Candidate spec: fold into `now-11-ci-quality-gate.md`'s CI setup, since CI should not have to swallow 6,355 lint errors as "expected."

---

## 2026-09-01 — CSP not manually verified in a live browser (now-09)

**Severity:** Low — static evidence is strong, but this is a "please click through it once" item, not a "please review my reasoning" item.

**What:** now-09 phase 1 added a `Content-Security-Policy` header (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; ...`) to the SPA's HTML response. I verified statically that the production build emits no inline `<script>` tags (only `<script type="module" src="...">`), which is the thing `script-src 'self'` (no `'unsafe-inline'`) would break if present. I did **not** start the dev servers and click through the app in an actual browser to confirm zero `Refused to ...` console violations end-to-end — the spec's own test table lists this as S7, a Playwright E2E check, which is explicitly deferred to the `now-11-ci-quality-gate.md` work (it needs the embedded build + a browser automation harness, which is its own setup).

**What I did:** Confirmed via `grep` on the built `dist/index.html` that no inline scripts exist, confirmed `style-src` includes `'unsafe-inline'` (Radix/Tailwind inject `style="..."` attributes and `<style>` tags at runtime, which this permits), and confirmed `connect-src 'self'` covers the app's only same-origin `fetch`/`EventSource` (SSE) calls by reading the API client code.

**Suggested next step:** Before this ships, run the dev servers (`cd backend && go run . -port 8080`, `cd frontend && PORT=8081 npm run dev`), open the app, and watch DevTools console for CSP violations while exercising import → search → theme toggle → export — the exact S7 flow. If `now-11`'s Playwright network-audit harness lands first, extend it to also assert zero CSP violation messages, per the spec's decision that S7 replaces the manual DevTools step.

---

## Notes on process (not an issue, for context)

- These work packages (`now-01`, `now-09` phase 1) were picked up in a single interactive session per the pickup order in `specs/README.md`, not via a scheduled/recurring agent. TBD.md's "Work progress log" section is the source of truth for what's been implemented; update it (not this file) when a spec is completed.
- Commits `8250556` (now-01) and `81bbeaa` (now-09 phase 1), plus the roadmap-docs commit and this file's own doc-update commits, are on the local `dev` branch only — **not pushed to `origin`** per explicit instruction. `origin` has no `dev` branch yet.
- No attribution trailer was added to any commit message, per explicit instruction for this session (this deviates from the standing Claude Code convention of appending `Co-Authored-By`/`Claude-Session` trailers — noted here so the deviation is visible, not because it's a problem).
- `now-09`'s phase 2 (per-launch bearer token, protecting against other local users on a shared machine) is v1.8 scope and was **not** attempted here — phase 1 only closes the DNS-rebinding gap. Don't read "now-09 done" as "the loopback API is now authenticated"; it still isn't.
