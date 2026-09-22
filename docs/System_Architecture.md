# LogSonic — System Architecture Documentation

## 1. Executive Summary

LogSonic is an offline-first, desktop log analytics tool built as a single self-contained Go binary that embeds a React SPA frontend. It ingests logs from local files, parses them with Grok patterns, indexes them in time-sharded Bleve indices, and provides full-text search with visualization. An MCP server extension allows external AI agents (Claude Desktop, Cursor, Windsurf) to query logs programmatically.

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
        SourceSel["SourceSelection<br/>(Local file source)"]
        FileSel["FileSelection<br/>(drag-drop, multi-file)"]
        PatternSel["LogPatternSelection<br/>(auto-detect + manual)"]
        CustomPat["CustomPatternSelector<br/>(Grok editor)"]
        FileAnalyze["FileAnalyzingStep<br/>(preview + test)"]
        ImportConfirm["ImportConfirmStep<br/>(batch upload)"]
        SuccessSum["SuccessSummaryStep"]
    end

    Home --> LogViewer
    Home --> Sidebar
    Home --> DistChart
    Home --> AIDialog
    Home --> Header
    Import --> SourceSel --> FileSel
    FileSel --> PatternSel --> CustomPat
    PatternSel --> FileAnalyze --> ImportConfirm --> SuccessSum

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

The import page (`#/import`) is a single surface: files land in a drop zone, detection runs for each of them the moment they arrive, and the file list + preview split pane shows what was found. Per-file configuration (pattern, timestamp, options) is one click away in a detail panel; "Import N files" in the sticky footer commits the batch.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Import page (React)
    participant Store as useImportStore (Zustand)
    participant API as Go API Server
    participant Tok as Grok Tokenizer
    participant Bleve as Bleve Storage

    Note over User,UI: Drop — files enter the list
    User->>UI: Drag & drop / browse (browser Files) or Dock / Open With (native paths)
    UI->>Store: addFiles(File[]) / addNativePathFiles(paths) → ImportFile[] with status "pending"

    Note over UI,API: Detect — parallel, capped, per pending file (useFileDetection)
    UI->>API: POST /api/v1/parse {logs: preview_lines} (no grok_pattern → autosuggest)
    API->>Tok: Try registered patterns against the sample
    API-->>UI: SuggestResponse {results[0] = best fit, multiline?}
    UI->>API: POST /api/v1/parse {logs, grok_pattern: best, source_mtime, multiline}
    API-->>UI: ParseResponse {logs, timestamp_inference}
    UI->>Store: updateFile(fileId, {selectedPattern, parsedLogs, status: "detected"}) + setFileTimestampInference
    Note over UI,Store: A detected multiline layout is stored on that file only (sessionOptions.multiline)

    Note over User,UI: Inspect — file list + preview; detail panel on demand
    alt User picks an alternative or saved pattern (Pattern tab)
        UI->>API: POST /api/v1/parse per saved pattern (20-line sample) → match %
        User->>UI: Click an alternative / "More patterns"
        UI->>API: POST /api/v1/parse {logs, grok_pattern}
        UI->>Store: updateFile(fileId, {selectedPattern, parsedLogs}) + inference
    else User writes a custom pattern (inline editor)
        User->>UI: Edit Grok, click "Test pattern"
        UI->>API: POST /api/v1/parse {logs, grok_pattern, custom_patterns}
        API-->>UI: ParseResponse → preview re-renders
    end
    opt Timestamp tab override (year / month / day / timezone / source field)
        UI->>Store: patchFileTimestampOverride(fileId, patch)
        UI->>API: POST /api/v1/timestamp/preview (debounced)
        API-->>UI: fresh TimestampInference
    end
    opt Options tab: multiline folding (per file)
        UI->>Store: updateFileSessionOptions(fileId, {multiline})
        UI->>API: POST /api/v1/parse {logs, grok_pattern, multiline} (explicit {enabled: false} = no folding, no auto-detect)
        API-->>UI: ParseResponse → preview shows the records the ingest will produce
    end

    Note over User,UI: Commit — "Import N files"
    opt A file uses a custom pattern
        UI->>User: SavePatternDialog (Save Pattern → POST /api/v1/grok, or Skip)
    end
    loop Per file in ImportFile[] (useUpload)
        UI->>API: POST /api/v1/ingest/start {pattern, source, session_options, timestamp_config, multiline: this file's}
        API->>Tok: Create dedicated session Tokenizer
        API-->>UI: {session_id: uuid}
        alt Browser File
            loop Per chunk
                UI->>API: POST /api/v1/ingest/logs {session_id, logs: chunk[]}
                API->>Bleve: Batch index by date shard
                UI->>Store: updateFile(fileId, {uploadProgress: %})
            end
        else Native path
            UI->>API: POST /api/v1/ingest/file {session_id, path} → job_id
            API-->>UI: SSE ingest_progress events
        end
        UI->>API: POST /api/v1/ingest/end {session_id}
        UI->>Store: updateFile(fileId, {uploadStatus: "success"})
    end
    UI->>User: Completion card → refresh /info → home after 5 s (no auto-redirect on partial failure)
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

## 6. AI Assistance Architecture

LogSonic integrates with external AI agents through the Model Context Protocol (MCP). The inline Ollama-based query translator that previously shipped in the UI has been removed in favor of a single, agent-driven integration point.

### MCP Server (External Agent Integration)

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
    
    subgraph "pkg/static"
        Embed["Embedded React SPA"]
    end
    
    Main --> Server
    Server --> H_Handlers
    H_Handlers --> Tok
    H_Handlers --> Store
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
AI assistance is delivered exclusively through the MCP server, which is started by the user's MCP client (Claude Desktop, Cursor, etc.) rather than by LogSonic itself. The core binary has no external network dependencies; all data and queries stay local.
