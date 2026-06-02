# Contributing to LogSonic

Thanks for your interest in LogSonic! Contributions of all kinds are welcome — bug reports, feature ideas, docs fixes, new Grok patterns, and code.

LogSonic's north star: **local-first log analytics that never phones home.** Please keep that in mind for any change — no telemetry, no required network calls, and any AI feature must be opt-in and bring-your-own-key or local-model (Ollama).

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/logsonic/logsonic/issues) with steps to reproduce, your OS, and the LogSonic version (`logsonic -help` shows it / check the release).
- **Request a feature** — describe the problem you're trying to solve, not just the solution.
- **Add a Grok pattern** — pattern detection lives in [log2grok](https://github.com/logsonic/log2grok). New log formats are some of the most valuable contributions.
- **Improve docs** — README, MCP setup, or the architecture docs.
- **Write code** — see [`good first issue`](https://github.com/logsonic/logsonic/labels/good%20first%20issue) for scoped starting points.

## Development setup

LogSonic is a Go backend + React frontend. **For development, always run the two as separate processes** — the embedded single-binary build is only for releases.

### Backend (port 8080)

Requires Go 1.25.7+.

```bash
cd backend
go run main.go -port 8080
# or hot-reload with air: ./scripts/dev.sh
```

### Frontend (port 8081)

Requires Node.js 20+. Vite defaults to 8080, so override the port to keep the backend port free:

```bash
cd frontend
npm ci
PORT=8081 npm run dev
```

Open http://localhost:8081 — the frontend talks to the backend at `http://localhost:8080` via CORS and hot-reloads on change.

### Tests

```bash
# Backend
cd backend && go test ./... -v

# Frontend
cd frontend && npm run test

# E2E (add --headed to watch it run)
cd frontend && node e2e-test.mjs
```

Full build, Docker, and MCP setup instructions are in the [README](README.md).

## Pull request guidelines

1. **Open an issue first** for anything beyond a small fix, so we can agree on the approach before you invest time.
2. **Branch from `main`** and keep PRs focused — one logical change per PR.
3. **Add or update tests** for behavior changes.
4. **Run the test suite** (`go test ./...` and `npm run test`) before pushing.
5. **Keep the offline guarantee intact** — a PR that adds telemetry or a non-optional network call won't be merged.
6. **Describe the change** in the PR: what problem it solves and how you verified it.

## Code style

- **Go** — standard `gofmt` / `go vet`. Match the surrounding code.
- **TypeScript / React** — the repo's ESLint + Prettier config; run `npm run lint` before pushing.

## Questions

Open a [discussion or issue](https://github.com/logsonic/logsonic/issues) — happy to help you get started.

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
