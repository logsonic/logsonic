# Releasing LogSonic

GoReleaser is used to build and publish cross-platform binaries to GitHub Releases.

## Prerequisites

- [GoReleaser](https://goreleaser.com/install/) installed (`brew install goreleaser`)
- A GitHub token with `repo` scope set as `GITHUB_TOKEN` env var

## Steps

1. Build the frontend (it gets embedded into the Go binary):
   ```bash
   cd frontend
   npm ci
   npm run build
   npm run build:copy
   cd ..
   ```

2. Tag the release:
   ```bash
   git tag -a v0.X.0 -m "Release v0.X.0"
   git push origin v0.X.0
   ```

3. Run GoReleaser from the `backend/` directory:
   ```bash
   cd backend
   goreleaser release --clean
   ```

   For a dry-run (no publish):
   ```bash
   cd backend
   goreleaser release --snapshot --clean
   ```

## GoReleaser Config

The GoReleaser config lives at [`backend/.goreleaser.yaml`](backend/.goreleaser.yaml). It builds for Linux, Windows, and macOS.
