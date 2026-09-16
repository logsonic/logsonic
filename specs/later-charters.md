# Later-horizon charters

**These are one-page charters, not executable specs.** Each depends on Next-horizon work landing first and will be expanded into a full spec (with the template used by the now-* files) when its dependencies exist. An agent picking these up should write the full spec as the first deliverable, not code.

---

## L1 — Team edition (open-core, self-hosted)

**Bet:** the free single-user app is the funnel; a self-hosted team server is the business. Local-first stays sacred — "self-hosted," never "our cloud."
**Shape:** the same binary with `--team` mode: authentication (start with simple token/OIDC, no user DB ambition), shared workspaces + case files, per-source retention policies, read-only viewer role. Frontend already talks same-origin REST; the delta is authz middleware + multi-user workspace ownership.
**Depends on:** case files (next-07) as the sharing primitive; watchers; the per-launch token from now-09 phase 2 (the seed of the auth story); a licensing decision (recommend: BSL or MIT-core + paid `enterprise/` module — needs maintainer's call, not an agent's).
**Spec must resolve:** auth story, license split, upgrade path from single-user data, whether team mode disables MCP or scopes it per-token.

## L2 — Metrics-from-logs

**Bet:** derived counters make LogSonic glanceable daily, not just searchable during incidents.
**Shape:** a saved query + interval = a metric ("5xx per minute"); computed by a background rollup over live rows (reuse the watcher evaluator from next-04 — a metric is a watcher that counts instead of alerting); stored in small per-day rollup files; pinned tiles on a dashboard strip above the histogram.
**Depends on:** next-04's hub evaluator; density/dashboard UI direction.
**Spec must resolve:** rollup storage format + retention, backfill over historical indexes (fan-out count queries) vs live-only, tile UI placement.

## L3 — Trace correlation

**Bet:** once OTLP ingest (next-01) lands, `trace_id` fields exist; one click on any row shows the whole trace across sources, time-ordered.
**Shape:** mostly UI + one query: `trace_id:<id>` across all sources/windows ± padding; a trace drawer with a per-source lane view. Cheap — schedule right after OTLP proves adoption.
**Depends on:** next-01. **Spec must resolve:** trace-id field detection heuristics for non-OTel logs (regex on common shapes), lane-view design.

## L4 — Parser/source plugin system

**Bet:** community-added sources (journald, syslog listener, S3, podman) and exotic formats without forking — solo-maintainer leverage.
**Shape decision to make in the spec:** external-process plugins speaking NDJSON over stdio (recommended: language-agnostic, crash-isolated, matches the `logsonic tail -` stdin model that already exists) vs Go plugins (rejected: platform/pinning pain) vs Wasm (heavier, revisit later).
**Depends on:** container sources (next-02) proving the managed-child-process pattern; watch manager (now-04) proving source lifecycle.
**Spec must resolve:** plugin manifest/discovery, capability contract (source vs parser), sandbox/permissions stance for a local-first tool.

## L5 — Windows & Linux native shells

**Bet:** port the macOS AppKit-shell pattern once macOS proves native matters (measure: share of macOS users on the .app vs CLI).
**Shape:** Windows = WebView2 + tray icon (b3 parity); Linux = WebKitGTK, lower priority (Linux users live happily in the browser/CLI).
**Depends on:** macos-b1..b3 shipped and validated by usage; distribution parity (now-05) so install channels exist.
**Spec must resolve:** shared shell-contract doc (the `__LOGSONIC_NATIVE__` interface — `platform`, `shellVersion`, `token`, `recentImports`, `__logsonicPerformAction`, the `logsonicNative` message channel — formalized across platforms), per-OS lifecycle equivalents of SIGINT draining, paths-not-bytes file handoff (now-08) on each OS.

## L6 — Whole-corpus facets (deferred optimization from now-02)

**Recorded so nobody "discovers" it:** now-02 deliberately computes facets over the bounded result window. Exact whole-corpus facets require keyword-analyzer sub-fields in the Bleve index mapping → a **reindex/migration of all user data**. Expand only if window-scoped facets prove insufficient in practice. The spec must include a background reindex-with-progress migration plan and a mixed-version index compatibility story — both built on the format-version file and migration runner from next-10.
