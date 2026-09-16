# now-11 — CI quality gate, network-audit test, bench harness

**Horizon:** Now (v1.7) · **Size:** S–M · **Priority:** P0
**TBD.md ref:** §1 engineering snapshot, §8 budgets, §9 verifiable "no network calls", §10 quality gates.
**Read `specs/README.md` first.**

## Goal

There are **no CI workflows** (`.github/workflows` does not exist; `RELEASE.md` §1 says so). Every later spec in this directory adds tests that nobody runs automatically. This task adds a PR gate, an automated proof of the "no network calls" promise, and a nightly bench harness that records the §8 budgets. Coverage numbers are **recorded first, then ratcheted** — this spec deliberately sets no percentage.

## Design decisions (made)

- **GitHub Actions**, three workflows:
  - `ci.yml` on `pull_request` + `push: main`. Jobs (parallel): `go` (ubuntu: `go vet`, `staticcheck`, `go test -race -count=1 ./...`, `govulncheck`), `web` (ubuntu: `npm ci`, `tsc --noEmit`, `eslint`, `vitest run --coverage` uploading the report as an artifact, `npm audit --audit-level=high` non-blocking for the first two releases), `swift` (macos-latest: the two `swiftc` invocations from `app-macos.sh` without signing; runs `ListeningURLTests` via `swift test`-style `xcrun swiftc -parse-as-library` + XCTest or a tiny `main` runner — pick whichever the existing tests already assume), `snapshot` (ubuntu: `goreleaser release --snapshot --clean --skip=publish` after `npm run build:copy`; uploads `dist/` as an artifact so packaging regressions surface on PRs), `e2e` (ubuntu: build embedded binary, start it on a random port, run the network-audit + smoke Playwright scripts). Target < 10 min wall time; cache Go modules, npm, and Playwright browsers.
  - `nightly.yml` (`schedule` 03:00 UTC + manual): bench harness (below) + full E2E set + `BenchmarkIndexSize*`; results committed as JSON to a `bench-results` branch (or uploaded as artifacts; choose artifacts first — no bot commits until the numbers stabilize).
  - `docs.yml`: link checker (`lychee`) over `README.md` + `docs/*.md` + `specs/*.md`; executes the code blocks tagged `bash` in `docs/development.md` that start with `go run .` / `npm` to prove the documented commands work (a tiny script, not a framework).
- **Network-audit E2E** (`frontend/e2e-network-audit.mjs`): Playwright launches Chromium against the **embedded** build, registers `page.route('**/*')` and records every request URL; drives import (`sample-logs/apache.log`) → search → toggle theme → export; asserts every request host is the server's host:port (or `blob:`/`data:`). Fails on any other host. This is the automated form of `now-01` T3 and the proof behind principle D2.
- **Smoke E2E** reuses `e2e-test.mjs` (already Playwright-style); adapt it to accept the port via env.
- **Swagger drift check:** run `swag init` in CI and `git diff --exit-code backend/docs/`. **`api-types.ts` mirror check:** a small script (`scripts/check-api-types.mjs`) that parses Go struct JSON tags from `pkg/types/types.go` and checks each `json:"name"` appears in `api-types.ts`; warn-only for one release, then blocking.
- **Bench harness** (`backend/bench/`): a Go program (not `testing.B`, for control over timing) that (1) generates a 10M-line Apache-style corpus into a temp storage dir if absent (cache it as an artifact), (2) runs the §8 scenarios: import throughput, search p50/p95 (term, term+facets once `now-02` lands, histogram, sorted), startup time with 365 indices, RSS after idle; (3) writes `bench.json`. A `compare.mjs` script prints deltas against a baseline file and exits non-zero beyond ±15 % — wired into nightly only.
- Required checks on `main`: `go`, `web`, `swift`, `snapshot`, `e2e`. Branch protection is a repo setting; note it in `RELEASE.md`.

## Anchors

`backend/.goreleaser.yaml`, `backend/scripts/release.sh` (frontend build steps to mirror), `frontend/e2e-*.mjs` (harness style: how they start browsers / find the app), `frontend/vitest.config.ts`, `backend/pkg/storage/index_size_benchmark_test.go`, `docs/development.md` (commands), `RELEASE.md` §1 (update "CI: none").

## Step-by-step

1. `.github/workflows/ci.yml` with the five jobs; caching; `permissions: contents: read`.
2. `frontend/e2e-network-audit.mjs` + make `e2e-test.mjs` port-configurable; a `scripts/run-e2e-ci.sh` that builds the embedded binary and starts it.
3. Swagger drift + api-types check scripts.
4. `backend/bench/` harness + `nightly.yml`.
5. `docs.yml` with lychee + doc-command execution.
6. `RELEASE.md` §1 + `docs/development.md` "CI" section; badge in README.

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| Q1 | open a PR touching Go only | `go` job runs and passes; wall < 10 min overall |
| Q2 | introduce `fetch('https://example.com')` in the SPA on a branch | `e2e` fails with the offending URL in the log |
| Q3 | change a swaggo annotation without regen | `go` job fails on drift |
| Q4 | add a JSON tag to `types.go` without mirroring | warning annotation appears (blocking after one release) |
| Q5 | nightly on `main` | `bench.json` artifact with all §8 scenarios populated |
| Q6 | break a README link | `docs.yml` fails |
| Q7 | Swift compile error in `LogsonicApp.swift` | `swift` job fails on a macOS runner |

## Acceptance criteria

- [ ] All workflows green on `main`; required checks configured; README badge.
- [ ] Network-audit E2E in place and green on the embedded build.
- [ ] Baseline coverage and bench numbers recorded in the PR description (not targets — numbers).
- [ ] `RELEASE.md` no longer says "CI: none".

## Out of scope

Signing/notarizing in CI (needs secret handling design — `RELEASE.md` §9), Windows E2E, visual regression screenshots (revisit after `macos-b1`), enforcing coverage thresholds (ratchet later).
