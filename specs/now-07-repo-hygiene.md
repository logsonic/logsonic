# now-07 — Repo hygiene (+ the `%` query fix and `--version`)

**Horizon:** v1.7 · trust sprint · **Size:** S (half a day) · **Priority:** P2 (but P1 for the two code fixes it carries)
**TBD.md ref:** §2 defects (dead link, `%` mangling, `--version`, #10 state), §5 v1.7 trust sprint.
**Read `specs/README.md` first.** This is a light spec on purpose — the two code changes each get one regression test; no larger matrix.

## Tasks

1. **Fix the `%` query double-decode (P1).** `storage/search.go` (`Search`) and `storage/search_page.go` (`buildPageQuery`) call `url.PathUnescape` on the query string that `net/http` already decoded. Verified: `message:"100%"` → 400 `invalid URL escape "%\""`; `message:"a%20b"` silently becomes `message:"a b"`. Delete both calls. Add a handler test: `GET /api/v1/logs?query=message%3A%22100%25%22` (i.e. the client sends `message:"100%"` properly encoded) returns 200 and the query echoed in `LogResponse.Query` is `message:"100%"`; a stored doc containing `100%` is found. The frontend already encodes params with `URLSearchParams` — confirm by grep in `api-client.ts` and note it in the PR.
2. **Add `--version`.** `main.go` gets `var version, commit, date = "dev", "", ""` (ldflags already inject `main.version/commit/date` per `.goreleaser.yaml`) and a `-version`/`--version` flag printing `logsonic <version> (<commit>, <date>, go<goversion>, <os>/<arch>)`. Also expose it in `/api/v1/info` as `app_version`, `commit`, `build_date` (the StatusBar shows the Vite-injected `__APP_VERSION__`; make it prefer the server's value so app-vs-CLI mismatches are visible). `now-05` (winget) and `now-13` (doctor) consume this.
3. **Fix the dead README link.** `README.md` (Documentation section) links `docs/production-readiness-plan.md`, which does not exist anywhere in git history. Replace the bullet with the public roadmap (task 5). Verify no other doc links are dead: check every relative link in `README.md` and `docs/*.md` resolves to a file (`grep -o '\[[^]]*\]([^)]*)' README.md docs/*.md` and check each target) — `now-11` automates this with lychee afterwards.
4. **Reconcile GitHub issue #10.** It is closed but the feature (field extraction) is unshipped. Open a fresh tracking issue titled "Faceted fields sidebar" referencing `specs/now-02-faceted-fields-sidebar.md` and noting it supersedes #10; comment on #10 pointing to it. Requires `gh` CLI, repo `logsonic/logsonic`.
5. **Publish a public `ROADMAP.md`** at repo root: distill `TBD.md` §3 (principles), §4 (thesis one-liner), §5 (Now/Next/Later tables WITHOUT internal priority/effort columns), §12 (non-goals). Do not copy §2 (internal defect list) verbatim — the font fix can be listed neutrally as "self-hosted fonts", the security work as "loopback hardening". Link it from README's Documentation section.
6. **Doc accuracy sweep.** `docs/development.md` says `go run main.go -port 8080 -auto-port=false` — change to `go run . -port 8080 -auto-port=false` (the `main` package has sibling files; `go run main.go` fails). Same doc says "Go 1.26.6 or later" — matches `go.mod`; but `specs/README.md` rev 1 said 1.23 (fixed in rev 2). `docs/Architecture.md` is a stub that predates workspaces, live tail, and the native app while `docs/System_Architecture.md` is current: merge the stub's still-true paragraphs into `System_Architecture.md`, delete `Architecture.md`, and update the README link. `docs/installation.md` says "Closing the app window stops the server" — still true until `macos-b3`; leave it but add a note in `macos-b3` to update it.
7. **Sweep stray files:** `.DS_Store` files exist at repo root, `demo/`, `backend/`, `docs/` — add `.DS_Store` to `.gitignore` if missing and `git rm --cached` any tracked ones. Check whether `backend/dist-dev/`, `backend/logsonic` (built binary), `frontend/dist/` are tracked; they should be ignored build outputs.

## Validation

- `%` regression test green; `logsonic --version` prints the injected version in a `goreleaser --snapshot` build.
- All README/docs relative links resolve.
- `git status` clean of `.DS_Store` noise after the sweep.
- `ROADMAP.md` renders correctly on GitHub (heading levels, tables).
- Issue #10 has a public pointer to the plan.

## Out of scope

Any other code change. The font fix itself (`now-01`). Host/CSP middleware (`now-09`).
