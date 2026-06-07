# Development

For development and testing, run the backend and frontend as separate processes. The embedded build (`build:copy` plus single binary) is for releases. In dev mode, the frontend talks to the backend at `http://localhost:8080` via CORS.

## Backend

Go 1.25.7 or later is required. For hot reload:

```bash
go install github.com/air-verse/air@latest
```

Run the backend on port 8080:

```bash
cd backend
./scripts/dev.sh
```

Or run it directly:

```bash
cd backend
go run main.go -port 8080
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
