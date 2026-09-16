# Development

For development and testing, run the backend and frontend as separate processes. The embedded build (`build:copy` plus single binary) is for releases. In dev mode, the frontend talks to the backend at `http://localhost:8080` via CORS.

## First-time setup

The backend embeds the built frontend (`backend/pkg/static/dist`, gitignored) via `//go:embed all:dist`. On a fresh clone that directory doesn't exist yet, so `go build`/`go run .`/`./scripts/dev.sh` all fail to compile with `pattern all:dist: no matching files found` until it exists at least once:

```bash
cd frontend
npm ci
npm run build
npm run build:copy
```

After that one-time build, backend-only iteration (`go run .`, `./scripts/dev.sh`) works without rebuilding the frontend again — dev mode serves the frontend from Vite instead, so the embedded copy only needs to exist, not be current.

## Backend

Go 1.26.6 or later is required. For hot reload:

```bash
go install github.com/air-verse/air@latest
```

Run the backend on fixed port 8080. The dev script exits if the port is already in use:

```bash
cd backend
./scripts/dev.sh
```

Or run it directly:

```bash
cd backend
go run . -port 8080 -auto-port=false
```

## Frontend

The frontend uses React 18, TypeScript, Vite, Zustand, Radix UI, Tailwind, and Recharts. Vite defaults to 8080, so use 8081 for local development:

```bash
cd frontend
npm ci
PORT=8081 npm run dev
```

Open `http://localhost:8081`. The frontend hot-reloads on change.

## Tests

Backend:

```bash
cd backend
go test ./... -v
```

Specific backend packages:

```bash
go test ./pkg/storage/ -v
go test ./pkg/server/handlers/ -v
```

Frontend:

```bash
cd frontend
npm run test
```

Coverage:

```bash
cd frontend
npx vitest run --coverage
```

E2E:

```bash
cd frontend
node e2e-test.mjs
node e2e-comprehensive.mjs
```

Pass `--headed` to open a visible browser window.

## Continuous integration

Three workflows, not one — `ci.yml` is the PR gate; `docs.yml` and `nightly.yml` run on their own triggers.

### `ci.yml` — on every PR and push to `main`

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Its jobs mirror the commands above, so a green local run is a green CI run:

| Job | What it runs |
|-----|--------------|
| `go` | `go build`, `go vet`, `staticcheck` (pinned), `go test -race ./...`, a Swagger drift check (`swag init` must produce no diff under `backend/docs/`), `govulncheck` |
| `web` | `npm ci`, `npm run build`, `vitest run --coverage` (report uploaded as an artifact); `tsc` and `eslint` on changed files are **non-blocking** until their pre-existing baselines are cleared, and the whole-tree counts are written to the job summary |
| `api-types` | `node .github/scripts/check-api-types.mjs` (+ its own `node --test`) — checks every Go JSON field name in `backend/pkg/types/types.go` appears as a property name *somewhere* in `frontend/src/lib/api-types.ts`, on any interface. **Warn-only for now** (blocking after one release, per the spec): it's a name-presence check, not a structural one — it can't tell a field mirrored on the wrong interface from a correct mirror, only catch a name missing everywhere |
| `swift` | `backend/scripts/test-macos-app.sh` on a macOS runner: compiles the shell for both architectures, runs the `ListeningURL` and `DragStrip` tests, builds and validates an ad-hoc app |
| `snapshot` | `goreleaser build --snapshot --id logsonic` — the Linux/Windows builds and the release config; the Darwin build needs a signing identity and is not built in CI |
| `e2e` | builds the real frontend into the embedded binary, then runs `frontend/e2e-network-audit.mjs` (fails on any request that leaves the server's origin), `frontend/e2e-test.mjs`, `frontend/e2e-facets.mjs` (the Fields panel: click-to-filter, alt-click-to-exclude), and `frontend/e2e-sources.mjs` (the Sources panel: delete through its confirm; status bar and `_src` facet update without a reload; then Settings → Storage: retention save/clear round-trips, delete-day through its confirm), and `frontend/e2e-watch.mjs` (Settings → Watched folders: add a watch, drop `sample-logs/apache.log` in, rows searchable under `watch.*`, stop the watch through its confirm; the script runs the server with `LOGSONIC_WATCH_SWEEP=2s`) via `.github/scripts/run-e2e.sh` |

Every Go job creates a placeholder `backend/pkg/static/dist/index.html` first: the real bundle is gitignored and `//go:embed all:dist` of a missing directory does not compile. Run the same script locally with the embedded binary you built:

```bash
bash .github/scripts/run-e2e.sh /path/to/logsonic-embedded 8080
```

### `docs.yml` — on a PR touching `*.md` or the checks themselves, and on push to `main`

[`.github/workflows/docs.yml`](../.github/workflows/docs.yml) is scoped to doc/script changes (path filters on the `pull_request` trigger), not every PR — a code-only change doesn't re-run it.

| Job | What it runs |
|-----|--------------|
| `links` | `.github/scripts/check-links.sh` — every relative Markdown link in `README.md`/`docs/*.md`/`specs/*.md`/etc. resolves to a real file |
| `external-links` | `lychee` against the same file set as `links` — every external `http(s)://` link resolves |
| `dev-commands` | `.github/scripts/check-dev-commands.sh` — actually runs the four bootstrap commands this doc's own "First-time setup"/"Backend"/"Frontend"/"Tests" sections tell a new contributor to type (`npm ci`, `go run . -port 8080 -auto-port=false`, `PORT=8081 npm run dev`, `npm run test`), grepped verbatim out of this file first so a doc edit that changes the wording fails loudly instead of silently testing stale text |

Run the same checks locally:

```bash
bash .github/scripts/check-links.sh
bash .github/scripts/check-dev-commands.sh
```

### `nightly.yml` — 03:00 UTC schedule + manual dispatch, never on a PR

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs work too slow for a PR gate.

| Job | What it runs |
|-----|--------------|
| `bench` | [`backend/bench/`](../backend/bench/), the §8-budget harness, at full scale (a 10M-line corpus, 365 real day-indices) — import throughput, term/facets/histogram search latency, storage-open time — written to `bench.json` and uploaded as an artifact; compared against a committed `backend/bench/baseline.json` if one exists (none does yet — no run has happened on a real runner, so there is nothing honest to compare against). Also runs the `BenchmarkIndexSize*` Go benchmark |
| `e2e-full` | the same `.github/scripts/run-e2e.sh` driver `ci.yml`'s `e2e` job uses, on the same schedule as `bench` rather than every PR |

Run the bench harness locally at a smaller scale (the full 10M-line run takes long enough that a nightly cadence, not a dev loop, is the point):

```bash
cd backend && go run ./bench -out bench/output/bench.json
```

## API Documentation

Swagger UI is available while the server is running:

```text
http://localhost:8080/api/v1/swagger/index.html
```

Regenerate Swagger docs after API changes:

```bash
cd backend
go run github.com/swaggo/swag/cmd/swag@v1.16.4 init -g pkg/server/server.go   # the version CI pins; a locally installed swag can differ
```
