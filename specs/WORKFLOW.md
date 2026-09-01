# Work-package workflow (read before picking any spec)

This is the checklist an agent — or a person — runs, top to bottom, for **one** work package from the pickup order in [`README.md`](README.md). It exists because the first two packages (now-01, now-09) shipped with defects a checklist would have caught: a contract change that missed two of its consumers, a browser-enforced header that was never loaded in a browser, and an ISSUES.md entry whose root cause was one `cat` away. Every step below is there because skipping it cost something once.

Invoke it as `/pickup` in Claude Code (a local pointer to this file), once per package — each run ends with a stop, so running it by hand per iteration is the intended cadence. `/loop 1h /pickup` also works for an unattended session, but the loop skill asks "cloud schedule or this session?" on any interval of an hour or more; answer **This session only**. Cloud routines are **not** used for this repo: they run on a fresh clone, and this branch is never pushed.

## Standing rules (the maintainer's, not negotiable)

- Work on the local `dev` branch. **Never push.** Never force-push, never touch `main`.
- One commit per work package, then one separate docs commit (TBD.md + ISSUES.md). Keep them separable; the supervisor may cherry-pick.
- **No attribution trailers** in commit messages (no `Co-Authored-By`, no session links).
- Never modify `specs/*.md` content except to fix a factual error found while implementing — and then say so in ISSUES.md.
- Never run a repo-wide formatter or `--fix`; never delete or rewrite code outside the package's scope to make a gate green.
- Use absolute paths in every shell command. **Never put `cd` in a compound command** — the shell's cwd persists between calls and drifts; two commands failed this way in one session.
- Scratch storage for any server you start: `-storage <scratch dir>` (CLI) or `open --env STORAGE_PATH=<scratch dir>` (app). Never let a test run write to the user's real index.

## 0. Preflight (2 minutes)

- [ ] `git branch --show-current` is `dev`; `git status --short` is clean. If not, stop and report — don't stash someone else's work.
- [ ] `lsof -ti:8080 -ti:8081 | xargs kill` — stale dev servers cause false failures.
- [ ] Read, in this order: `TBD.md` **Work progress log** (what is Done / Partial / Blocked), `ISSUES.md` (open items — some may be remediable now, see §5), `specs/README.md` pickup table.
- [ ] **Toolchain gate.** Before choosing a spec that needs it: `xcrun -f swiftc` (macOS shell work), `docker info` (container specs), desktop-control permission (only needed to *see* the native app; without it you can still build and launch it). If the toolchain is absent, skip the spec, log one line in ISSUES.md, take the next one.

## 1. Pick

- [ ] Take the first spec in pickup order that is not Done and whose "Depends on" entries are Done. A Partial spec continues from its recorded phase.
- [ ] Size the slice: an S spec is one package. An M/L spec is one *named phase* per package — write the phase boundary down before starting (e.g. "now-09 phase 1: allow-list + CSP + JSON-only; phase 2 token not attempted").
- [ ] Re-read the spec's **Design decisions (made)** and **Test cases** tables in full. Acceptance criteria are the definition of done; each box is either checked or explicitly deferred with a reason.

## 2. Plan → advisor gate 1

- [ ] Write down: files to touch, the contract that changes (if any), how each acceptance box will be verified, what is deferred.
- [ ] **Consumer sweep (mandatory when any contract changes** — a header, a content type, a CSP directive, a URL shape, an event name, a DTO field, a CLI flag). Enumerate every client and check each one against the new rule before writing code:

  | Consumer | Where |
  |----------|-------|
  | Web app HTTP client | `frontend/src/lib/api-client.ts` (`apiRequest`) |
  | Native-file fetch (dock drop / Open With) | `frontend/src/components/Import/LocalFileImport/FileSelection.tsx` (`fetch(logsonicfile://…)`) |
  | SSE consumer | `frontend/src/hooks/useLogStream.ts` (`EventSource`) |
  | CLI | `backend/tail_cli.go` (and any later `open_cli.go`, `doctor_cli.go`) |
  | MCP tool handlers | `backend/pkg/mcp/server.go` (REST calls to the local API) |
  | Native shell + its injected JS | `backend/macos/LogsonicApp.swift` (`blobDownloadHookJS`, `deliverNativeFiles`, `/info` fetch, `Info.plist` in `scripts/app-macos.sh`) |
  | Demo and E2E scripts | `demo/*.mjs`, `frontend/e2e-*.mjs` |
  | Container image | `Dockerfile` (`HOST=0.0.0.0`) |
  | Docs that state the contract | `docs/configuration.md`, `docs/live-streaming.md`, `mcp/SKILLS.md`, `README.md` |

  now-09 missed the second and sixth rows and shipped two native-app regressions. The sweep is the fix.
- [ ] Call `advisor` with the plan. Apply what it says; if evidence contradicts it, say so in a second call rather than silently choosing.

## 3. Implement

- [ ] Follow the spec's step order. Match surrounding code style; comment only non-obvious constraints.
- [ ] Every new behavior gets a test in the same commit (Go handler/unit test, vitest, Swift unit test where the logic is pure). Every new endpoint gets swaggo annotations + `swag init -g pkg/server/server.go`; every DTO change is mirrored in `frontend/src/lib/api-types.ts`.
- [ ] New JSON state files under `<storage>` are written atomically and carry a `version`.
- [ ] Error messages follow the standard: *what* failed, *which* file/line/pattern/field, *what to do*.

## 4. Verify — at the level the change lives at

Unit tests prove logic. They do not prove a served header works in a browser or that the native bridge still fetches. Pick every row that applies:

| The change touches… | Required verification |
|---------------------|-----------------------|
| Any Go code | `go build ./... && go vet ./... && go test ./...` from `backend/`; `gofmt -l` on touched files only (three pre-existing files are unformatted — leave them) |
| Any frontend code | `npx vitest run`; `npx eslint <touched files>` (the repo-wide gate is red with ~6,300 pre-existing errors — see ISSUES.md — so compare **per-file error count before vs after**, and require zero errors on lines you added) |
| Served HTML/headers/CSP, or the embedded bundle | `npm run build && npm run build:copy` (both `dist/` dirs are gitignored), `go build -o <scratch>/logsonic .`, run it on a scratch storage dir, open it in Chrome via the browser tools. **CSP reports do not reach the console-messages tool** — install `document.addEventListener('securitypolicyviolation', …)` in-page *before* interacting and read it back. Drive load → search → theme toggle → export. Seed rows through the API first (`/ingest/start` → `/ingest/logs` → `/ingest/end`). |
| The native bridge (`LogsonicApp.swift`, `logsonicfile:`, downloads, `__LOGSONIC_NATIVE__`) | `LOGSONIC_DEV_NO_OPEN=1 bash backend/scripts/dev-macos-app.sh <scratch binary>` then `open --env STORAGE_PATH=<scratch> -a backend/dist-dev/Logsonic.app <file>`. Seeing the result needs desktop-control permission; if it is not granted, record the exact command and expected outcome in ISSUES.md as **manual-pending** — do not mark the box verified. |
| A CLI flag or subcommand | Run the binary with the flag; paste the output in the commit message |
| Docs | Every relative link resolves (`grep -o '\[[^]]*\]([^)]*)'` and check targets) |

- [ ] Re-run the spec's test table row by row; note the ID of any row not run and why.

## 5. Remediation pass (before anything goes in ISSUES.md)

For every problem found — a failing gate, a surprising number, a behavior that contradicts the spec — do this **before** writing it up:

1. **Root-cause, 10-minute budget.** First move: find the config that governs the behavior (`.prettierrc`, `eslint.config.js`, `vite.config.ts`, `Info.plist`, `.goreleaser.yaml`, the middleware chain). The "6,355 lint errors" entry from now-01 blamed the codebase; the cause was two config files disagreeing, visible with one `cat`.
2. **Measure before choosing.** When two conventions conflict, count both outcomes and pick by the numbers; put the numbers in the commit message (6,352 vs 5,425 was the quote-style decision).
3. **Classify**, then act:
   - *Fixable in scope* → fix it in this package's commit.
   - *Fixable, safe, out of scope* (a config-only fix, a missing globals block, a wrong test fixture) → fix it in its **own** small commit with its own message. Formatting-only rewrites of files you did not otherwise touch are never "safe": they destroy `git blame` and conflict with every branch.
   - *Needs a human* (a house-style choice with real cost either way, a licensing/naming/product decision, anything that deletes code you don't own) → ISSUES.md, with the measured numbers, the options, and your recommendation.
4. **Advisor gate 2** — call `advisor` with the diff, the test output, and the classified list. It may reclassify; it may spot the consumer you missed. Apply, then re-verify what changed.

## 6. Commit

- [ ] Work-package commit: touched code + tests + docs the spec names. Message: what changed, *why* (the spec section), what was verified and how (name the commands and the browser/native checks), what was deferred. No trailer.
- [ ] If step 5 produced separate safe fixes, they are their own commits, before or after — never folded in.

## 7. Record → advisor gate 3 → docs commit

- [ ] `TBD.md` Work progress log: one row per spec. **Amend** an existing row for a spec you continued; never add a duplicate. Status vocabulary, exactly:
  - `✅ Done` — every acceptance box checked, each with *verified by: test | browser | native | manual*.
  - `🟡 Partial (phase n/m)` — what shipped, what remains, which boxes are open.
  - `⛔ Blocked` — the blocker and what unblocks it.
  Never write Done with an open acceptance box, and never write "fixed" for something verified only by reasoning — write "fixed, unverified: <exact manual step>".
- [ ] `ISSUES.md`: newest first. Close entries you remediated in place ("**Closed <date>** — root cause… fix in commit …"); don't delete them. New entries follow the template: severity from the implementer's view, what, why it matters, what you did, suggested next step, and the measured numbers.
- [ ] Call `advisor` once more on the TBD/ISSUES text — it catches overclaims ("regressions fixed" when one was unverified).
- [ ] Docs commit: `TBD.md` + `ISSUES.md` (+ `specs/*.md` only if a factual correction was made). No trailer. Then stop.

## 8. Stop conditions

Stop and report (do not start another package) when: the package is committed and recorded; or the time box is up (one hour for a session loop — record the phase reached as Partial); or a gate fails for a reason outside the package and the fix is not classified as safe; or `git status` shows changes you did not make.
