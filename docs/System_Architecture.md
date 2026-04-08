# LogSonic — System Architecture Documentation

## 1. Executive Summary

LogSonic is an offline-first, desktop log analytics tool built as a single Go binary (~10 MB) that embeds a React SPA frontend. It ingests logs from local files or AWS CloudWatch, parses them with Grok patterns, indexes them in time-sharded Bleve indices, and provides full-text search with visualization. Optional AI assistance (via local Ollama) translates natural language queries into Bleve syntax, and an MCP server extension allows external AI agents to query logs programmatically.

---

## 2. High-Level Component Architecture

```mermaid
graph TB
    subgraph "User Layer"
        Browser["Browser UI<br/>(React + Vite + TailwindCSS)"]
        MCP_Client["MCP Client<br/>(Claude Desktop / Cursor)"]
    end

    subgraph "Server Layer (Go Binary)"
        Router["Chi Router<br/>+ Middleware Stack"]
        Static["Embedded Static<br/>File Server (SPA)"]
        Handlers["Handler Layer"]
        Tokenizer["Grok Tokenizer"]
        Storage["Bleve Storage Engine"]
        CW_Client["CloudWatch Client<br/>(AWS SDK v2)"]
        AI_Proxy["Ollama AI Proxy"]
    end

    subgraph "External Services"
        Ollama["Local Ollama Instance<br/>(gemma3:12b fine-tuned)"]
        AWS["AWS CloudWatch Logs"]
    end

    subgraph "Persistence"
        LevelDB["LevelDB / Scorch<br/>(Time-Sharded .bleve indices)"]
        GrokJSON["grok.json<br/>(Pattern Registry)"]
    end

    Browser -->|"REST API"| Router
    MCP_Client -->|"stdio"| MCP_Server
    MCP_Server["MCP Server<br/>(Node.js / FastMCP)"] -->|"HTTP"| Router

    Router --> Static
    Router --> Handlers
    Handlers --> Tokenizer
    Handlers --> Storage
    Handlers --> CW_Client
    Handlers --> AI_Proxy

    CW_Client --> AWS
    AI_Proxy --> Ollama

    Storage --> LevelDB
    Handlers --> GrokJSON
    Tokenizer -->|"elastic/go-grok"| Tokenizer
```

---

## 3. Frontend Architecture

```mermaid
graph LR
    subgraph "Pages"
        Home["Home.tsx<br/>(Search + Results)"]
        Import["Import.tsx<br/>(Ingestion Wizard)"]
        NotFound["NotFound.tsx"]
    end

    subgraph "State (Zustand Stores)"
        ImportStore["useImportStore<br/>(multi-file, patterns, sessions)"]
        SearchStore["useSearchQueryParams<br/>(query, filters, pagination)"]
        ColorStore["useColorRuleStore<br/>(row highlighting rules)"]
        SysInfo["useSystemInfoStore<br/>(server health, dates)"]
        LogResult["useLogResultStore<br/>(currently displayed logs)"]
    end

    subgraph "Core Components"
        LogViewer["LogViewer<br/>(virtualized table)"]
        Sidebar["Sidebar<br/>(field facets + filters)"]
        DistChart["LogDistributionChart<br/>(time histogram)"]
        AIDialog["AIQueryDialog<br/>(NL to Bleve)"]
        Header["Header<br/>(search bar + controls)"]
    end

    subgraph "Import Components"
        SourceSel["SourceSelection<br/>(Local / CloudWatch)"]
        FileSel["FileSelection<br/>(drag-drop, multi-file)"]
        PatternSel["LogPatternSelection<br/>(auto-detect + manual)"]
        CustomPat["CustomPatternSelector<br/>(Grok editor)"]
        FileAnalyze["FileAnalyzingStep<br/>(preview + test)"]
        ImportConfirm["ImportConfirmStep<br/>(batch upload)"]
        SuccessSum["SuccessSummaryStep"]
        CWProvider["CloudWatchLogProvider<br/>(group/stream picker)"]
    end

    Home --> LogViewer
    Home --> Sidebar
    Home --> DistChart
    Home --> AIDialog
    Home --> Header
    Import --> SourceSel --> FileSel
    FileSel --> PatternSel --> CustomPat
    PatternSel --> FileAnalyze --> ImportConfirm --> SuccessSum
    SourceSel --> CWProvider

    Home --- SearchStore
    Home --- LogResult
    Home --- ColorStore
    Home --- SysInfo
    Import --- ImportStore
```

### Key Frontend Concepts

| Concept | Implementation | Notes |
|---|---|---|
| **State Management** | Zustand (non-persisted stores) | Atomic stores prevent cross-feature re-renders |
| **Styling** | TailwindCSS + PostCSS | Utility-first with custom config |
| **Bundler** | Vite (React + TypeScript) | Hot-reload dev on `:8081`, production embedded in Go binary |
| **Multi-File** | `ImportFile[]` array in `useImportStore` | Each file tracks its own pattern, status, and progress independently |
| **API Layer** | `lib/api-client.ts` + `lib/api-types.ts` | Typed fetch wrappers with shared response types |

---

## 4. Multi-File Import Flow

The import wizard supports selecting multiple local files simultaneously, each with independent pattern detection and upload tracking.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Import Wizard (React)
    participant Store as useImportStore (Zustand)
    participant API as Go API Server
    participant Tok as Grok Tokenizer
    participant Bleve as Bleve Storage

    Note over User,UI: Step 1 — Source Selection
    User->>UI: Choose "Local File" or "CloudWatch"

    Note over User,UI: Step 2 — File Selection (Multi-File)
    User->>UI: Drag & drop or browse multiple files
    UI->>Store: addFiles(File[]) → creates ImportFile[] with unique IDs
    Store-->>UI: Render file list with per-file status = "pending"

    Note over User,UI: Step 3 — Pattern Detection & Configuration
    UI->>API: POST /api/v1/parse {logs: preview_lines[0..100]}
    Note right of API: No grok_pattern → triggers autosuggest
    API->>Tok: Try every registered pattern against sample
    Tok-->>API: Score each pattern (fields_extracted / lines)
    API-->>UI: SuggestResponse {results: sorted by score}
    UI->>Store: setAvailablePatterns(results)
    
    alt User selects a suggested pattern
        User->>UI: Click suggested pattern card
        UI->>Store: updateFilePattern(fileId, pattern)
    else User creates a custom pattern
        User->>UI: Edit Grok expression in CustomPatternSelector
        UI->>API: POST /api/v1/parse {logs, grok_pattern, custom_patterns}
        API->>Tok: Compile & test custom pattern
        Tok-->>API: ParseResponse {logs, processed, failed}
        API-->>UI: Display preview results
        User->>UI: Click "Save Pattern"
        UI->>API: POST /api/v1/grok (persist to grok.json)
    end

    User->>UI: Click "Test Pattern"
    UI->>Store: testPattern()
    Store->>API: POST /api/v1/parse {logs: preview[0..20], grok_pattern}
    API-->>UI: ParseResponse with parsed field tokens

    Note over User,UI: Step 4 — Batch Ingestion
    User->>UI: Confirm import
    loop Per file in ImportFile[]
        UI->>API: POST /api/v1/ingest/start {pattern, source, session_options}
        API->>Tok: Create dedicated session Tokenizer
        API-->>UI: {session_id: uuid}
        loop Per chunk (configurable batch size)
            UI->>API: POST /api/v1/ingest/logs {session_id, logs: chunk[]}
            API->>Tok: ParseLogs(chunk, sessionOptions)
            Tok-->>API: Structured maps with _raw, timestamp, fields
            API->>Bleve: Batch index by date shard
            Bleve-->>API: Success
            API-->>UI: {processed: N, failed: M}
            UI->>Store: updateFile(fileId, {uploadProgress: %})
        end
        UI->>API: POST /api/v1/ingest/end {session_id}
        API-->>UI: Session cleaned up
        UI->>Store: updateFile(fileId, {uploadStatus: "complete"})
    end
    
    UI->>Store: setCurrentStep(4) → SuccessSummaryStep
```

### Multi-File State Model

Each file in the `files: ImportFile[]` array carries its own lifecycle state:

```
ImportFile {
  id: string                    // Unique ID (file-{timestamp}-{counter})
  file: File                    // Browser File handle
  fileName: string
  fileSize: number
  previewLines: string[]        // First ~100 lines for pattern detection
  approxLines: number
  
  // Pattern Configuration (per-file)
  detectedPattern: Pattern | null
  selectedPattern: Pattern | null
  isCustomPattern: boolean
  customPattern: Pattern | null
  customPatternTokens: Record<string, string>
  
  // Detection State
  detectionStatus: 'pending' | 'detecting' | 'detected' | 'error'
  detectionError: string | null
  
  // Upload State
  uploadStatus: 'pending' | 'uploading' | 'complete' | 'error'
  uploadProgress: number        // 0..100
  uploadError: string | null
  totalLinesProcessed: number
  
  // Per-file session options
  sessionOptions: FileSessionOptions {
    smartDecoder: boolean       // Auto-detect IPs, emails, UUIDs
    timezone: string            // Force timezone override
    year/month/day: string      // Force date component overrides
  }
}
```

---

## 5. Custom Grok Pattern Lifecycle

Grok patterns are central to LogSonic's ability to parse arbitrary log formats. The system manages both built-in and user-defined ("custom") patterns.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as CustomPatternSelector
    participant Store as useImportStore
    participant API as Go API
    participant GrokFile as grok.json (disk)
    participant Tok as Tokenizer (go-grok)

    Note over UI: User writes a Grok expression like<br/>%{IP:client} %{WORD:method} %{URIPATH:request}
    
    User->>UI: Type Grok pattern string
    User->>UI: Optionally define named sub-patterns<br/>(custom_patterns map)
    UI->>Store: setCreateNewPattern({pattern, custom_patterns})
    
    User->>UI: Click "Test Pattern"
    UI->>API: POST /api/v1/parse<br/>{logs: sample, grok_pattern, custom_patterns}
    API->>Tok: NewTokenizer() → fresh instance
    
    alt custom_patterns provided
        API->>Tok: AddCustomPattern(name, subpattern) for each
    end
    
    API->>Tok: AddPattern(main_pattern) → compiles via go-grok
    API->>Tok: ParseLogs(sample_lines, session_options)
    
    alt Pattern matches
        Tok-->>API: Parsed tokens + success/fail counts
        API-->>UI: ParseResponse {logs: [{field:value}...]}
        UI->>UI: Render PatternTestResults table
    else Pattern fails
        Tok-->>API: Error or 0 successes
        API-->>UI: Error response
        UI->>UI: Show error banner
    end

    User->>UI: Click "Save Pattern"
    UI->>UI: Open SavePatternDialog
    User->>UI: Enter name + description
    
    UI->>API: POST /api/v1/grok<br/>{name, pattern, custom_patterns, priority, description}
    API->>API: Validate name uniqueness
    API->>GrokFile: Append to grok.json (type: "custom")
    API-->>UI: 201 Created
    
    Note over GrokFile: Pattern now available for<br/>future autosuggest scoring
```

### Pattern Storage Architecture

```
grok.json
├── patterns[]
│   ├── {name: "SYSLOG_RFC3164", pattern: "%{...}", type: "standard", priority: 10}
│   ├── {name: "APACHE_COMBINED", pattern: "%{...}", type: "standard", priority: 8}
│   ├── {name: "NGINX_ACCESS",   pattern: "%{...}", type: "standard", priority: 8}
│   └── {name: "My Custom Log",  pattern: "%{...}", type: "custom",   priority: 0,
│         custom_patterns: {"MYTOKEN": "[A-Z]{3}-\\d+"}}
```

**Key behaviors:**
- **Autosuggest** creates a _fresh_ `Tokenizer` per pattern to test. Each candidate pattern is compiled, run against the sample lines, and scored by `fields_extracted / total_lines`.
- **Session Tokenizer**: When ingestion starts (`/ingest/start`), a dedicated `Tokenizer` instance is created and stored in the `sessionMap` keyed by UUID. This isolates concurrent ingestion sessions.
- **Pattern Priority**: Patterns are sorted by priority (descending) during `preparePatterns()`. The first pattern to successfully match a line wins.
- **Smart Decoder**: An optional post-parse pass extracts IPs, emails, URLs, MACs, and UUIDs using compiled regexes, adding them as `_ipv4_addr`, `_email_addr`, etc.

---

## 6. CloudWatch Import Flow

LogSonic can pull logs from AWS CloudWatch (region/profile auto-detected from local AWS CLI config).

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as CloudWatchLogProvider
    participant CWStore as useCloudWatchStore
    participant API as Go API
    participant CW as AWS CloudWatch SDK

    User->>UI: Select "CloudWatch" source
    User->>UI: Enter region + optional profile
    
    UI->>API: POST /api/v1/cloudwatch/log-groups<br/>{region, profile}
    API->>CW: DescribeLogGroups (paginated)
    CW-->>API: LogGroup[] {name, arn, storedBytes, retentionDays}
    API-->>UI: List of log groups
    
    User->>UI: Select a log group + time range
    UI->>API: POST /api/v1/cloudwatch/log-streams<br/>{log_group, start_time, end_time}
    API->>CW: DescribeLogStreams (filtered by time range)
    CW-->>API: LogStream[] {name, firstEventTime, lastEventTime}
    API-->>UI: Available streams in time window
    
    User->>UI: Select log stream(s) + confirm
    loop Per selected stream (paginated, max 10000/page)
        UI->>API: POST /api/v1/cloudwatch/log-events<br/>{log_group, log_stream, start_time, end_time, limit, next_token}
        API->>CW: GetLogEvents
        CW-->>API: LogEvent[] {timestamp, message}
        API-->>UI: Events + next_token + has_more flag
    end
    
    UI->>UI: Concatenate all events into text blob
    UI->>Store: setFileFromBlob(concatenated_text, filename)
    Note over Store: Creates a virtual File object from blob<br/>Sets preview lines, advances to Step 2
    
    Note over User,UI: From here, normal pattern detection<br/>and ingestion flow continues
```

### CloudWatch Client Architecture

The CloudWatch client (`pkg/cloudwatch/client.go`) wraps the AWS SDK v2:

| Method | AWS API | Pagination | Notes |
|---|---|---|---|
| `ListLogGroups` | `DescribeLogGroups` | Token-based (all pages) | Returns all groups in account |
| `ListLogStreams` | `DescribeLogStreams` | Token-based, time-filtered | Filters by `firstEventTime`/`lastEventTime` overlap |
| `GetLogEvents` | `GetLogEvents` | Forward token, configurable `limit` (default 10000) | Returns `hasMore` flag based on token equality + result count |

**Metadata tagging**: CloudWatch-sourced logs carry metadata fields (`aws_region`, `log_group`, `log_stream`) injected via `IngestSessionOptions.Meta`, which are indexed as regular Bleve fields for filtered search.

---

## 7. AI Assistance Architecture

LogSonic offers two independent AI integration paths:

### 7a. Ollama Query Translation (Inline)

Built into the search UI for users who find Bleve query syntax difficult.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as AIQueryDialog
    participant API as Go API (/ai/*)
    participant Ollama as Local Ollama<br/>(logsonic model)

    Note over UI,API: Startup: check AI availability
    UI->>API: GET /api/v1/ai/status
    API->>Ollama: GET http://localhost:11434/api/tags
    
    alt Ollama running + logsonic model found
        Ollama-->>API: {models: ["logsonic:latest", ...]}
        API-->>UI: {ollama_running: true, models_available: [...]}
        UI->>UI: Show AI assistant button in search bar
    else Ollama not available
        API-->>UI: {ollama_running: false}
        UI->>UI: Hide AI features gracefully
    end
    
    User->>UI: Click AI button → type "show me all errors from the API service"
    UI->>API: POST /api/v1/ai/translate-query<br/>{query: "...", logs: {sample_log_fields}}
    
    API->>API: findLogsonicModel(available_models)<br/>Priority: "logsonic" > "logsonic:latest" > *logsonic*
    API->>Ollama: POST http://localhost:11434/api/generate<br/>{model: "logsonic", prompt: JSON(request), stream: false}
    
    Note over Ollama: Fine-tuned gemma3:12b model<br/>with Bleve syntax examples<br/>(temperature: 0.1 for determinism)
    
    Ollama-->>API: {response: "+level:error +service:api"}
    API-->>UI: {bleve_query: "+level:error +service:api", success: true}
    
    UI->>UI: Populate search bar with translated query
    User->>UI: Execute search
```

#### Ollama Model Design

The custom Ollama model (`ollama/Modelfile`) is built on `gemma3:12b` with:
- **System prompt**: Detailed Bleve syntax rules (boolean operators, wildcards, regex, escaping, numeric ranges)
- **Few-shot examples**: 20+ training pairs mapping natural language → Bleve queries
- **Low temperature** (0.1): Minimizes creativity, maximizes syntax precision
- **Model selection**: `findLogsonicModel()` searches available models for name containing "logsonic"

### 7b. MCP Server (External Agent Integration)

A standalone Node.js process using the `FastMCP` framework, communicating over `stdio`.

```mermaid
graph LR
    subgraph "MCP Client"
        Claude["Claude Desktop"]
        Cursor["Cursor IDE"]
    end

    subgraph "MCP Server (Node.js)"
        FMCP["FastMCP Server<br/>v1.0.0"]
        T1["Tool: query_logs"]
        T2["Tool: log_info"]
        T3["Tool: logsonic_url"]
    end

    subgraph "LogSonic API"
        Logs["GET /api/v1/logs"]
        Info["GET /api/v1/info"]
    end

    Claude -->|"stdio"| FMCP
    Cursor -->|"stdio"| FMCP
    FMCP --> T1 --> Logs
    FMCP --> T2 --> Info
    FMCP --> T3
```

| MCP Tool | LogSonic API | Description |
|---|---|---|
| `query_logs` | `GET /api/v1/logs` | Full search with query, time range, pagination, source filter. Embeds Bleve syntax documentation in tool description. |
| `log_info` | `GET /api/v1/info` | Returns available dates, sources, storage stats. Strips `system_info` for conciseness. |
| `logsonic_url` | (generates URL) | Constructs a browser-openable URL with query params pre-filled |

**Configuration**: `LOGSONIC_HOST` and `LOGSONIC_PORT` env vars (defaults: `localhost:8080`).

---

## 8. Search & Query Execution

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as SearchBar + LogViewer
    participant Store as useSearchQueryParams
    participant API as Go API
    participant Storage as Bleve Storage
    participant Indices as Daily Shards<br/>(LevelDB / Scorch)

    User->>UI: Enter query, set time range, filters
    UI->>Store: Update query params (debounced)
    Store->>API: GET /api/v1/logs?query=...&start_date=...&end_date=...&sort_by=timestamp&sort_order=desc&limit=1000&offset=0

    API->>Storage: Search(queryStr, startDate, endDate, sources)
    Storage->>Storage: Identify date range → filter existing index dates
    
    par Concurrent search across shards (NumCPU × 2 goroutines)
        Storage->>Indices: Shard 2024-01-15: NewSearchRequest(query)
        Indices-->>Storage: Hits[]
    and
        Storage->>Indices: Shard 2024-01-16: NewSearchRequest(query)
        Indices-->>Storage: Hits[]
    and
        Storage->>Indices: Shard 2024-01-17: NewSearchRequest(query)
        Indices-->>Storage: Hits[]
    end
    
    Storage->>Storage: Merge results, filter by exact timestamp range
    Storage-->>API: Results[] + query duration
    
    API->>API: Sort by requested field + order
    API->>API: Apply offset/limit pagination
    API->>API: Compute log_distribution histogram
    API->>API: Extract available_columns from result fields
    API-->>UI: LogResponse {logs, count, total_count, time_taken, log_distribution, available_columns}
    
    UI->>UI: Render LogViewer table + DistributionChart + Sidebar facets
```

### Client-Side vs Server-Side Operations

| Operation | Where | Mechanism |
|---|---|---|
| Text search | Server (Bleve) | `QueryStringQuery` with full Bleve syntax |
| Time range filter | Server | Date-shard selection + post-filter on timestamps |
| Source filter | Server | Conjunction query on `_src` field |
| Field facet filtering | Client | Post-query filtering on rendered results |
| Color rule highlighting | Client | `useColorRuleStore` regex/contains rules |
| Column visibility | Client | Toggle which fields render in LogViewer |
| Sort | Server | Applied after merge, before pagination |
| Pagination | Server | offset/limit slicing |

---

## 9. Backend Package Architecture

```mermaid
graph TB
    Main["main.go<br/>(CLI, config, server init)"]
    
    subgraph "pkg/server"
        Server["server.go<br/>(Chi router, middleware, routes)"]
        subgraph "handlers"
            H_Handlers["handlers.go — Services struct (DI container)"]
            H_Ingest["ingest.go — Session-based ingestion"]
            H_Parse["parse.go — Parse + autosuggest"]
            H_Grok["grok.go — Pattern CRUD + persistence"]
            H_Logs["logs.go — Search, sort, paginate, distribution"]
            H_Info["info.go — System info + caching"]
            H_CW["cloudwatch.go — CloudWatch proxy"]
            H_AI["ai_query.go — Ollama proxy"]
            H_Ping["ping.go — Health check"]
            H_GrokPat["grok_patterns.go — Default pattern definitions"]
        end
    end
    
    subgraph "pkg/tokenizer"
        Tok["tokenizer.go<br/>- Grok compile/parse<br/>- Smart decoder (regex)<br/>- Timestamp normalization<br/>- Thread-safe (sync.RWMutex)"]
    end
    
    subgraph "pkg/storage"
        Store["storage.go<br/>- Time-sharded indices<br/>- Batch indexing<br/>- Type conversion"]
        Search_Go["search.go<br/>- Concurrent shard search<br/>- Semaphore throttling<br/>- Date iteration"]
    end
    
    subgraph "pkg/cloudwatch"
        CWClient["client.go — AWS SDK v2 wrapper"]
        CWTypes["types.go — LogGroup, LogStream, LogEvent"]
    end
    
    subgraph "pkg/static"
        Embed["Embedded React SPA"]
    end
    
    Main --> Server
    Server --> H_Handlers
    H_Handlers --> Tok
    H_Handlers --> Store
    H_CW --> CWClient
```

### Middleware Stack (in order)

1. `RequestID` — Unique ID per request
2. `RealIP` — Extracts client IP from proxy headers
3. **Custom Logger** — Skips `/api/v1/ping` logging to reduce noise
4. `Recoverer` — Catches panics, returns 500
5. `Timeout(60s)` — Request deadline
6. `ThrottleBacklog(10, 50, 5s)` — Rate limiting: 10 concurrent, 50 queued, 5s queue timeout
7. **Security Headers** — `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`
8. **CORS** — Restricted to `localhost:*` and `127.0.0.1:*`

---

## 10. Storage Engine Deep Dive

### Time-Sharding Strategy

```
.logsonic/
├── grok.json                    # Pattern registry
├── logs-2024-01-15.bleve/       # One Bleve index per calendar day
│   └── store/                   # LevelDB (Scorch engine)
├── logs-2024-01-16.bleve/
└── logs-2024-01-17.bleve/
```

### Index Mapping Configuration

| Field | Type | Indexed | Stored | Term Vectors | Notes |
|---|---|---|---|---|---|
| `timestamp` | DateTime | ❌ | ✅ | ❌ | Stored for retrieval, not search-indexed (date filtering is shard-based) |
| `_raw` | Text (standard analyzer) | ✅ | ✅ | ❌ | Full log text for fallback search. `IncludeInAll = true` |
| Dynamic fields | Text (standard analyzer) | ✅ (IndexDynamic) | ✅ (StoreDynamic) | ❌ | All Grok-extracted fields |

### LevelDB Tuning

```go
kvConfig := map[string]interface{}{
    "block_size":                32768,     // 32KB (better compression ratio)
    "write_buffer_size":         16777216,  // 16MB (better batching)
    "lru_cache_capacity":        33554432,  // 32MB LRU cache
    "bloom_filter_bits_per_key": 15,        // Bloom filter for read perf
    "compression":               "snappy",  // Fast compression
}
```

### Document ID Scheme

```
{unix_nanosecond_timestamp}-{source_filename}-{line_index}
```

Example: `1705320000000000000-access.log-42`

---

## 11. Ingest Session Architecture

Ingestion uses a session model to isolate concurrent uploads and maintain per-session tokenizer state.

```mermaid
stateDiagram-v2
    [*] --> SessionCreated: POST /ingest/start
    SessionCreated --> Ingesting: POST /ingest/logs (batches)
    Ingesting --> Ingesting: More chunks
    Ingesting --> SessionClosed: POST /ingest/end
    SessionClosed --> [*]
    
    Ingesting --> SessionExpired: 60 min timeout
    SessionExpired --> [*]
    
    note right of SessionCreated
        Creates UUID session ID
        Instantiates dedicated Tokenizer
        Stores in sessionMap (sync.RWMutex)
    end note
    
    note right of Ingesting
        Each batch: ParseLogs → Store
        Returns processed/failed counts
        Invalidates info cache
    end note
```

**Key design decisions:**
- Each session gets its **own Tokenizer instance** so concurrent ingests with different patterns don't interfere
- Sessions have a **60-minute timeout** constant (though cleanup is currently manual via `/ingest/end`)
- The session map uses `sync.RWMutex` for safe concurrent access
- After each successful ingest batch, the **info cache is invalidated** to ensure fresh stats

---

## 12. Core Concepts & Design Decisions

### Time-Sharded Indices
By creating one `.bleve` index per calendar day, the system:
- Bounds memory usage per search window
- Makes deleting old data cheap (drop index directory)
- Enables parallel search across shards
- Naturally partitions write load

### Grok Pattern Priority System
Patterns are sorted by priority (highest first). When parsing a log line, the **first successful match wins**. This prevents expensive multi-pattern evaluation and gives user-defined patterns precedence over defaults.

### Smart Decoder
A post-parse enrichment step that uses compiled regexes to detect and extract:
- IPv4 addresses → `_ipv4_addr`
- Email addresses → `_email_addr`
- URLs → `_urls`
- MAC addresses → `_mac_addr`
- UUIDs → `_uuids`

These are prefixed with `_` to distinguish from Grok-extracted fields.

### Embedded SPA Architecture
The production Go binary embeds the entire React build output via `embed.FS`. The server handles SPA routing by serving `index.html` for any non-API, extensionless path (client-side routing support).

### Synchronous Ingestion
The current REST ingestion parses logs synchronously on the HTTP goroutine. This simplifies the architecture but couples HTTP request latency with CPU-bound Grok parsing, placing backpressure directly on the client.

### Offline-First AI
The Ollama integration is designed to degrade gracefully. The status check at startup determines feature availability, and its absence is Never an error — the AI button simply doesn't appear.
