# Development

For development and testing, run the backend and frontend as separate processes. The embedded build (`build:copy` plus single binary) is for releases. In dev mode, the frontend talks to the backend at `http://localhost:8080` via CORS.

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

Pull requests run [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Its jobs mirror the commands above, so a green local run is a green CI run:

| Job | What it runs |
|-----|--------------|
| `go` | `go build`, `go vet`, `staticcheck` (pinned), `go test -race ./...`, a Swagger drift check (`swag init` must produce no diff under `backend/docs/`), `govulncheck` |
| `web` | `npm ci`, `npm run build`, `vitest run --coverage` (report uploaded as an artifact); `tsc` and `eslint` on changed files are **non-blocking** until their pre-existing baselines are cleared, and the whole-tree counts are written to the job summary |
| `swift` | `backend/scripts/test-macos-app.sh` on a macOS runner: compiles the shell for both architectures, runs the `ListeningURL` tests, builds and validates an ad-hoc app |
| `snapshot` | `goreleaser build --snapshot --id logsonic` — the Linux/Windows builds and the release config; the Darwin build needs a signing identity and is not built in CI |
| `e2e` | builds the real frontend into the embedded binary, then runs `frontend/e2e-network-audit.mjs` (fails on any request that leaves the server's origin) and `frontend/e2e-test.mjs` via `.github/scripts/run-e2e.sh` |

Every Go job creates a placeholder `backend/pkg/static/dist/index.html` first: the real bundle is gitignored and `//go:embed all:dist` of a missing directory does not compile. Run the same scripts locally with the embedded binary you built:

```bash
bash .github/scripts/run-e2e.sh /path/to/logsonic-embedded 8080
bash .github/scripts/check-links.sh
```

## API Documentation

Swagger UI is available while the server is running:

```text
http://localhost:8080/api/v1/swagger/index.html
```

Regenerate Swagger docs after API changes:

```bash
cd backend
go install github.com/swaggo/swag/cmd/swag@latest
swag init -g pkg/server/server.go
```
