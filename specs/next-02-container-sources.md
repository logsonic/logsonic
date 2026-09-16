# next-02 — Container log sources (Docker / Kubernetes)

**Horizon:** Next · **Size:** M · **Priority:** P1. Medium-depth spec.
**Read `specs/README.md` first.**

## Goal

Follow `docker logs` and `kubectl logs` streams as first-class live sources with per-container labels — the modern equivalent of tailing a file.

## Design decisions (made)

- **Shell out to the CLIs (`docker logs -f`, `kubectl logs -f`); do NOT link client libraries.** Rationale: zero new heavyweight deps in the single binary; the CLIs handle auth/context (kubeconfig, docker contexts) for free; failure modes are legible strings. Detect availability with `exec.LookPath`.
- Architecture: this is the `logsonic tail` stdin path with a managed child process. Extend the live-source model (`handlers/live.go`, `LiveFileRequest` pattern) with a new source kind `container`: request carries `{runtime: "docker"|"kubernetes", target: "<container|pod>", namespace?, follow: true, tail_lines: 1000}`. The manager owns the child process, restarts on exit with backoff (max 5), and stops it on `DELETE /api/v1/live/sources/{id}`.
- Source naming: `docker.<container-name>` / `k8s.<namespace>.<pod>`. Docker timestamps: run with `--timestamps` and strip/parse the RFC3339Nano prefix into `timestamp` (container clocks beat ingest-time). K8s: `--timestamps` likewise.
- Discovery endpoints for the picker UI: `GET /api/v1/containers?runtime=docker` → `docker ps --format json` parsed; `?runtime=kubernetes` → `kubectl get pods -o json` (current context, all namespaces flag opt-in). Return name/state/image; errors (daemon down, no kubeconfig) become a typed `unavailable` response the UI renders as guidance, not failure.
- Parsing: container lines run through the same auto-detect (log2grok) used at import, with detection performed on the first 100 lines then locked, matching the tail flow's behavior (verify how `tail_cli.go`/live path picks patterns and mirror it).

## Anchors

`handlers/live.go` (source lifecycle, hub), `tail_cli.go` (stdin flow), `server.go:277-280` (control routes), `types.go:107-148` (live DTOs), Import UI source-picker patterns in `frontend/src/components/Import/` (CloudWatchImport is the precedent for a remote-source picker), `stores/useLiveLogStore.ts`.

## Step-by-step (condensed)

1. `backend/pkg/container/` — child-process runner (spawn, restart/backoff, stop; context-driven), discovery via CLI JSON output; unit tests with a fake `docker`/`kubectl` script on PATH (`t.TempDir()` + PATH override — this makes the whole matrix CI-safe with no real Docker).
2. Live-source integration: new kind wired into the hub; control routes reuse existing pause/resume/stop.
3. Discovery handler + swaggo + regen.
4. Frontend: "Containers" tab in the Import/live area following CloudWatchImport's structure: runtime toggle → list with state badges → follow buttons; active container sources appear in `SourceTabs`/live UI like any tail.

## Test cases

Backend (fake-CLI): F1 spawn+stream lines → rows in hub with correct `_src`; F2 child exits → restarted with backoff, max 5 then state=error; F3 stop → child killed (no zombie; check process-group kill); F4 timestamps parsed from `--timestamps` prefix; F5 discovery parses `docker ps` fixture + `kubectl get pods` fixture; F6 missing CLI → typed unavailable, no crash. Handler: create/stop/pause round-trip. E2E (requires real Docker, mark optional): follow a `docker run --rm alpine sh -c 'while true; do echo hi; sleep 1; done'` container; rows stream into the UI.

## Acceptance criteria

- [ ] Docker + kubectl follow work end-to-end manually; fake-CLI unit matrix green in CI without Docker.
- [ ] Daemon-down and no-kubeconfig states render as friendly guidance in the picker.
- [ ] Stopping LogSonic leaves no orphaned `docker logs`/`kubectl` processes (verify with `pgrep`).

## Out of scope

Docker API socket integration, k8s label-selector multi-pod follow, podman (should work via CLI compat — note untested), Windows container runtimes.
