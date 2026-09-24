# next-01 — OTLP log ingest endpoint

**Horizon:** Next (v2.x) · **Size:** M · **Priority:** P0 — the strategic bet.
**TBD.md ref:** §5 Next. Medium-depth spec: architecture + contract decided; handler internals follow existing patterns.
**Read `specs/README.md` first.**

## Goal

Any OpenTelemetry SDK or Collector pointed at `http://localhost:<port>` can ship logs into LogSonic with zero config beyond the endpoint URL. LogSonic becomes the default local OTel sink during development.

## Design decisions (made)

- **Mount at the OTLP-standard path `POST /v1/logs` at the ROUTER ROOT** — not under `/api/v1`. Collectors/SDKs default to `<endpoint>/v1/logs`; making that work verbatim is the entire point. Register it in `server.go` BEFORE the SPA catch-all (`r.HandleFunc("/*", …)` at line 294) and inside its own group with the standard timeout middleware (OTLP posts are short). Note: `/api/v1/logs` (existing GET search route) and `/v1/logs` must not be confused in docs.
- **Protocol support v1: OTLP/HTTP with both encodings** — `application/json` and `application/x-protobuf` (gRPC is out of scope; the Collector can always be configured for http). Use the official `go.opentelemetry.io/proto/otlp` generated types; JSON decoding via `protojson` (OTLP JSON is protojson, NOT plain encoding/json — a classic trap: fields like `traceId` are base64/hex per spec).
- **Field mapping** (OTel → LogSonic document):
  - `timeUnixNano` (fallback `observedTimeUnixNano`, fallback now) → `timestamp`
  - `severityText` (fallback number→name table) → `level`
  - `body` (string or stringified any) → `message`
  - resource attr `service.name` → `service`; also drives the source: `_src = "otlp.<service.name>"` (fallback `otlp.default`)
  - `traceId`/`spanId` hex → `trace_id`/`span_id`
  - remaining resource+log attributes flattened with dots (`http.method`) as top-level fields; collision rule: log attr beats resource attr; cap 100 attrs/record, drop + count the rest.
- **Storage:** map each record to the per-day index by its timestamp via the normal `StoreWithIDs` path (`storage/storage.go:218`); batch per request. Respect the day-index fan-out model — a single OTLP batch may span days; group records by date before storing.
- **Response contract:** OTLP `ExportLogsServiceResponse` (empty on full success; `partialSuccess.rejectedLogRecords` + message when some records were dropped). HTTP 200 on success/partial, 400 on undecodable, 415 on wrong content-type. This exact shape is what makes collectors not retry-loop.
- **Live feed:** OTLP-ingested rows also publish to the live hub (same as tail rows) so an open browser sees them stream in. Reuse whatever `live.go` exposes for tail-row publication.
- Rate/size guards: reuse bounded-import constants; max request body 10 MB (collector default batches are ≪ that).

## Anchors

`server.go` routing (lines 233–294); `storage/storage.go:218 StoreWithIDs`; `handlers/live.go` publish path; bounded-import limits in `handlers/ingest.go`; swaggo + regen; frontend needs NO changes except docs (`docs/` page: "OTel setup", with collector + SDK config snippets).

## Step-by-step (condensed)

1. `backend/pkg/otlp/` new package: decode (json+pb), map, group-by-day; pure functions, heavily unit-tested. 2. Handler `handlers/otlp.go` + route. 3. Live-hub publication. 4. `docs/otel.md` + README feature bullet. 5. Swagger annotation (mark as OTLP-spec endpoint).

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| O1 | canonical protojson fixture (taken from the OTLP spec examples) | 200; docs searchable with mapped fields |
| O2 | protobuf-encoded same payload | identical result |
| O3 | batch spanning two days | records land in two day-indices |
| O4 | missing timestamps | observedTime/now fallbacks applied |
| O5 | severityNumber only (no text) | mapped via number table (1–4 TRACE … 21–24 FATAL) |
| O6 | 150 attributes | capped at 100; partialSuccess NOT triggered (attrs dropped ≠ records rejected); drop count logged |
| O7 | one malformed record in a batch of 10 | 9 stored; partialSuccess.rejectedLogRecords=1 |
| O8 | wrong content-type | 415 |
| O9 | 20 MB body | rejected, bounded |
| O10 | **end-to-end with a real collector**: `otel-collector` docker container with `otlphttp` exporter → localhost | rows appear in UI live view and search; THIS is the acceptance test |
| O11 | existing `/api/v1/logs` GET + SPA routes unaffected (regression) | route table test |

## Acceptance criteria

- [ ] A stock OpenTelemetry Collector config containing only `endpoint: http://host.docker.internal:8080` exports successfully (O10 scripted in `backend/scripts/` or documented step-by-step in `docs/otel.md`).
- [ ] Unit matrix green; partial-success semantics exact per OTLP spec.
- [ ] Facets (now-02) and search work over OTel attribute fields.

## Out of scope

OTLP/gRPC, traces/metrics signals, TLS/auth (loopback-only stance unchanged), trace correlation UI (later charter).
