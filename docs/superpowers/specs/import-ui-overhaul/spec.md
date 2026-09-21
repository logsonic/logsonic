# Import UI Overhaul — Functional Specification

**Date:** 2026-09-19
**Status:** Draft
**Horizon:** Now

---

## Table of Contents

1. [Goal & Motivation](#goal--motivation)
2. [Core Principles](#core-principles)
3. [Current State (Baseline)](#current-state-baseline)
4. [UX Flow](#ux-flow)
5. [Empty State](#empty-state)
6. [Drop Zone](#drop-zone)
7. [File List Panel](#file-list-panel)
8. [Preview Pane](#preview-pane)
9. [Detail Panel](#detail-panel)
10. [Upload Progress](#upload-progress)
11. [Success / Completion](#success--completion)
12. [Error Handling](#error-handling)
13. [Store Changes](#store-changes)
14. [Component Architecture](#component-architecture)
15. [API Contract](#api-contract)
16. [Platform Considerations](#platform-considerations)
17. [Constraints](#constraints)
18. [Out of Scope](#out-of-scope)
19. [Related Specs](#related-specs)

---

## Goal & Motivation

Replace the current 3-step wizard-based import UI with a single-surface, full-width, split-pane "Inspect & Commit" layout. The import page becomes a focused, standalone entry point at `#/import`.

**Motivation:**

1. **Too constrained:** The current import lives in a horizontally limited centered box (max-width 960px), making it feel cramped and cluttered.
2. **Too many decisions:** The 3-step wizard forces the user through pattern selection, timestamp configuration, custom pattern editors, and ingest options — much of which is unnecessary 80% of the time.
3. **Future-ready:** The import surface must scale to accommodate new source types (containers, OTLP) and integrate with the sources catalog (`now-10`).
4. **Clarity:** The current step 2 (`FileAnalyzingStep`, 913 lines) crams too much into one view: per-file cards, pattern selectors, custom editors, preview tables, timestamp builders, and session options all at once.

---

## Core Principles

1. **All user input is error.** The ideal import requires zero decisions from the user: drop files, see what was detected, click import. Every additional click or toggle represents a failure of auto-detection or a deliberate power-user override.

2. **Progressive disclosure.** Show only what the user needs at their current stage. Empty state? Just the drop zone. Files added? Surface the file list and preview. Need to tweak? Open the detail panel. Complexity lives one interaction deep.

3. **Full-width, uncluttered.** Use the entire viewport. No centered box. Every element earns its space.

4. **Inspect before commit.** Users who want confidence before importing (timestamp looks right, fields parse correctly) should get it at a glance, not through a multi-step wizard.

5. **The default path is the fast path.** Drop files → see auto-detected results → click "Import." The fastest import is measured in seconds, not clicks.

---

## Current State (Baseline)

The import UI at `#/import` is a 3-step wizard rendered inside a centered box (max-width 960px):

**Step 1 — Choose Log Source:**
- File drop zone + file list. Supports browser `File` objects and native shell path drops via `logsonic-native-files` CustomEvent.
- File type badges (`.log`, `.txt`, `.json`), size limit warning ("up to 5 GiB each"), MIME validation.
- Files appear as removable cards with name + size.

**Step 2 — Define Log Pattern:**
- Auto-detection runs sequentially per-file. Progress bar: "N/M files analyzed."
- Summary header: "N matched · N need attention."
- Per-file expandable cards with: status pill (Queued/Detecting/Pattern found/Manual selection needed), pattern name, match rate indicator (green/yellow/red dot + percentage), expandable pattern selector dropdown (Command UI), Test button, custom Grok pattern textarea with dnd-kit draggable token chips, detection error banner, full preview table with pagination, expandable rows, syntax-highlighted raw lines.
- Timestamp toolbar: status chip + format label + collapsible Settings drawer with `TimestampBuilder` (editable Year/Month/Day/Timezone tiles with color-coded provenance).
- Collapsible "Ingest Session Options" card: Smart Decoder, Force Timezone, Force Year/Month/Day, Multiline Records (ISO8601/syslog/indent/custom regex).
- "Re-detect all" button.
- Confirmation gate for ambiguous timestamps.
- "Apply to all" for multi-file timestamp settings.

**Step 3 — Summary:**
- Success/failure icon (green check or check+X combo).
- Stats grid: "Succeeded", "Failed"/"Files", "Lines processed".
- Per-file results list with status icon, file name, pattern used, line count, or error message.
- Auto-redirect countdown (5s) to Home.
- On redirect: resets store, refreshes system info, navigates to `/`.

**Navigation:** Left button (Cancel/Back) + Right button (Next/Import/Home), gated by validation (file count, pattern selection, timestamp confirmation, multiline header validity).

### Key Source Files (current)

| File | Lines | Purpose |
|------|-------|---------|
| `pages/Import.tsx` | 541 | Wizard orchestrator |
| `UploadSteps/FileAnalyzingStep.tsx` | 913 | Step 2: pattern config, preview, timestamp |
| `UploadSteps/UploadingStep.tsx` | 243 | Upload progress during step 2→3 transition |
| `UploadSteps/SuccessSummaryStep.tsx` | 329 | Step 3: summary + redirect |
| `UploadSteps/HandleNavigation.tsx` | 153 | Back/Next buttons + validation gates |
| `UploadSteps/LogSourceSelectionStep.tsx` | 34 | Step 1 wrapper |
| `LocalFileImport/FileSelection.tsx` | 491 | Drop zone + file list |
| `LocalFileImport/FileSelectionService.ts` | 199 | File reading utilities |
| `UploadSteps/LogPatternSelection.tsx` | 250 | Pattern search/select dropdown |
| `UploadSteps/CustomPatternSelector.tsx` | 521 | Custom Grok editor with dnd-kit |
| `UploadSteps/TimestampBuilder.tsx` | 583 | Visual timestamp editor tiles |
| `UploadSteps/TimestampToolbar.tsx` | 255 | Timestamp chip + settings drawer |
| `UploadSteps/IngestSessionOptions.tsx` | 242 | Session options card |
| `UploadSteps/PatternTestResults.tsx` | 440 | Pattern test preview table |
| `UploadSteps/StatusBanner.tsx` | 57 | Dismissible banner |
| `UploadSteps/SavePatternDialog.tsx` | 258 | Save custom pattern dialog |
| `hooks/useUpload.ts` | 269 | Upload orchestrator |
| `hooks/ingestJobEvents.ts` | 151 | SSE job progress tracking |
| `stores/useImportStore.ts` | 660 | Zustand store |
| `types/index.ts` | 184 | TypeScript types |
| `utils/patternUtils.tsx` | 198 | Field extraction, highlighting |

---

## UX Flow

```
┌────────────────────────────────────────────────────────┐
│                    EMPTY STATE                          │
│                                                        │
│              ┌──────────────────────┐                   │
│              │                      │                   │
│              │   ⬇  Drop log files   │                  │
│              │   here to get         │                  │
│              │   started             │                  │
│              │                      │                   │
│              └──────────────────────┘                   │
│              or click to browse                          │
│              .log .txt .json · up to 5 GiB each          │
│                                                        │
└────────────────────────────────────────────────────────┘
                      │ files dropped
                      ▼
┌────────────────────────────────────────────────────────┐
│  ⬇ Drop more files · 3 selected                         │ ← compact drop strip
├────────────────────┬───────────────────────────────────┤
│                    │                                   │
│  FILES             │         PREVIEW                   │
│  ─────             │         ───────                   │
│  ● app.log         │  1 Jun 15 14:31:22 myhost sshd..  │
│    syslog 98%      │  2 Jun 15 14:32:05 myhost sshd..  │
│  ● access.log      │  3 Jun 15 14:33:10 myhost ker..   │
│    common 94%      │                                   │
│  ● errors.json     │                                   │
│    json 99%        │                                   │
│                    │                                   │
│  [Import 3 files]  │                                   │ ← sticky footer CTA
│  ~51K lines·20.7MB│                                   │
└────────────────────┴───────────────────────────────────┘
                      │ user clicks file's configure icon
                      ▼
┌────────────────────────────────────────────────────────┐
│  ⬇ Drop more files · 3 selected                         │
├────────────────────┬───────────────────────────────────┤
│                    │                                   │
│ ← Back to files    │         PREVIEW                   │
│                    │         ───────                   │
│ app.log            │  1 Jun 15 14:31:22 myhost sshd..  │
│ 2.1 MB · ~12,400   │  2 Jun 15 14:32:05 myhost sshd..  │
│                    │  3 Jun 15 14:33:10 myhost ker..   │
│ [Pattern|Tstamp|   │                                   │
│  Options]           │  (preview updates live as user    │
│                    │   changes pattern/timestamp)       │
│ ┌────────────────┐ │                                   │
│ │ syslog  98% ✓  │ │                                   │
│ │ %{SYSLOGTIM..} │ │                                   │
│ └────────────────┘ │                                   │
│ common      94%    │                                   │
│ generic-log 12%    │                                   │
│                    │                                   │
└────────────────────┴───────────────────────────────────┘
                      │ user clicks "Import 3 files"
                      ▼
┌────────────────────────────────────────────────────────┐
│  Import in progress… 3 files                            │
├────────────────────────────────────────────────────────┤
│                                                        │
│              ⏳                                         │
│         Importing 3 files                              │
│      12,400 of ~51,000 lines                           │
│                                                        │
│      ┌─────────────────────────┐                       │
│      │████████░░░░░░░░░░░░░░░░░│ 24%                   │
│      └─────────────────────────┘                       │
│                                                        │
│      ▶ Show per-file details  ▼                        │
│        ✓ app.log     12,400 lines                      │
│        ● access.log   4,200 / 45K                       │
│        ○ errors.json  queued                           │
│                                                        │
│              Cancel import                              │
│                                                        │
└────────────────────────────────────────────────────────┘
                      │ upload completes
                      ▼
┌────────────────────────────────────────────────────────┐
│                                                        │
│                   ✅                                    │
│              Import complete                            │
│           3 files · 51,200 lines                        │
│                                                        │
│         Redirecting to home in 5s…                     │
│            View in LogSonic →                           │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## Empty State

**Mockup:** `mockups/empty-state.html` (Option C chosen)

The import page before any files are added.

### Visual Design

- Full viewport height and width
- Centered, tall drop zone with generous padding (approx 60px top/bottom)
- Large downward arrow or upload icon (40px+)
- Primary heading: "Drop log files here to get started" (16px, semibold)
- Secondary text: "or click to browse · .log, .txt, .json · up to 5 GiB each" (13px, muted color)
- Dashed purple/mauve border (2px, accent color from the LogSonic palette)
- Light purple tinted background (`#f5f0ff` or equivalent)
- Rounded corners (8px)

### Behavior

- The entire zone is a drop target
- Clicking anywhere opens the native file picker
- Dragging files over the page shows a visual highlight on the zone
- Native shell path drops (from macOS Finder, etc.) are handled via the `logsonic-native-files` CustomEvent listener
- No other UI elements visible in this state (no step indicators, no empty panels)

### States

| State | Visual |
|-------|--------|
| Default | As described above |
| Dragging over | Border changes to solid, slight scale up (102%), background intensifies |
| Error (invalid file type dropped) | Brief red flash + toast "Only .log, .txt, and .json files are supported" |

---

## Drop Zone (After Files Added)

**Mockup:** `mockups/empty-state.html` (Option C, "After files added" section)

Once files have been added, the drop zone transforms into a compact horizontal strip at the top of the page. Below it, the split-pane sheet slides up.

### Visual Design

- Compact height (approx 40-48px)
- Full width, same dashed border style but thinner (1.5px)
- Text: "⬇ Drop more files · N selected" (12px, muted)
- Same purple/mauve accent
- The sheet below uses a subtle top shadow (`box-shadow: 0 -2px 12px rgba(0,0,0,0.05)`) and rounded top corners (8px) to create a "sheet" effect

### Behavior

- Always visible, always accepting drops
- Adding more files adds them to the existing file list
- Duplicate detection: silently ignore duplicate paths/names
- Size validation: reject files over 5 GiB with a toast

---

## File List Panel

**Mockup:** `mockups/options-import.html` (Option A chosen — import CTA in sticky footer)

The left 40% of the split pane. Shows all added files and batch actions.

### Visual Design

- White background with subtle border (1px, `#e6e9ef`)
- "Files" heading at top (11px, semibold)
- Each file as a clickable row with:
  - Status dot: green (≥ 95% match), amber (≥ 80%), red (< 80%) — 8px circle
  - File icon (generic file icon or type-specific)
  - File name (semibold, 11px)
  - File size (muted, same row)
  - Pattern name + match % on second line (10px)
  - Configure icon/button on the right edge (gear or "…" icon)
- Selected file has a subtle blue background highlight (`#f0f4ff`)

### Batch Actions

Located between the file list and the import footer:

- "Apply [pattern name] to all" — shown when a pattern is detected/selected for any file. Click applies the current pattern of the selected file to all files. Shows a brief confirmation ("Applied syslog to 3 files").
- Text style: 10px, accent color, clickable

### Import Footer (Sticky)

Sticky at the bottom of the left panel, separated by a border:

- "Import N files" button: full width within the panel, accent blue (`#1e66f5`), white text, 12px semibold, rounded (6px), 9-10px padding
- Below the button: "~51,000 lines · 20.7 MB" summary (9px, muted, centered)
- Disabled state: button grayed out with inline reason text in red/amber below (e.g., "Resolve ambiguous timestamps before importing")

### States

| State | Behavior |
|-------|----------|
| Detection pending | Status dot is an animated pulse (neutral blue); pattern shows "Detecting…" |
| Detection completed | Pattern + match % shown; status dot colored |
| Detection failed | Red status dot; pattern shows "Detection failed" with retry icon |
| File selected | Blue highlight background; preview pane updates |
| Detail panel open | File list hidden entirely, replaced by detail panel |

---

## Preview Pane

**Mockup:** `mockups/detail-panel.html` (right pane in both options)

The right 60% of the split pane. Shows live log lines from the selected file.

### Visual Design

- White background with subtle border
- Header bar: "Preview" heading (10px, semibold, system font) + file name
- Monospace content area (10px, `#1e1e2e` text)
- Line numbers in muted color (`#6c7086`) in the left gutter (approx 24px wide, right-aligned)
- Fields highlighted with color-coded backgrounds using the existing palette from `patternUtils.tsx`:
  - Timestamp fields: light blue (`#f0f4ff`)
  - Host fields: light amber (`#fef0d0`)
  - Process fields: light green (`#e7f5e7`)
  - Message fields: light pink (`#fdf0f5`)
  - Other fields: additional soft pastels
- Lines with timestamp parse errors: amber warning icon (⚠) on the line number gutter
- Footer bar: "18 more lines · Test with another pattern →" (10px, accent color for the link)

### Behavior

- Shows the first 20-50 lines from the selected file (from `previewLines` in the store)
- Pattern changes (via detail panel) trigger a debounced preview update calling `POST /parse`
- Timestamp changes (via detail panel) trigger a debounced preview update calling `POST /timestamp/preview`
- Scrollable if preview lines exceed the panel height
- When no file is selected, show a placeholder: "Select a file to see preview" with a file icon

### States

| State | Visual |
|-------|--------|
| No file selected | Centered placeholder with file icon + "Select a file to see preview" |
| File selected, detection pending | Preview lines shown raw (no highlighting) |
| File selected, pattern detected | Preview lines with field highlighting |
| Pattern being tested | Subtle loading overlay on the preview area |
| Config change applied | Brief flash on changed fields to indicate the update |

---

## Detail Panel

**Mockup:** `mockups/settings-panels.html` (Option B chosen), `mockups/detail-panel.html` (Option A chosen), `mockups/timestamp-tab.html` (Option B chosen)

When the user clicks a file row's configure button or the "Configure" action, the left panel switches from the file list to a detail panel for that file.

### Visual Design

- Same width and borders as the file list panel
- **Header area (always visible):**
  - "← Back to files" link (10px, accent color, clickable)
  - File name (11px, semibold)
  - File size + approximate line count (10px, muted): "2.1 MB · ~12,400 lines"
- **Tab bar:** Pattern | Timestamp | Options (10px, bottom border indicator on active tab, accent blue underline)
- **Tab content area:** scrollable, padding 10px

### Pattern Tab

**Mockup:** `mockups/detail-panel.html` (Option A chosen)

Selected pattern as a prominent card:

- Light green background (`#e7f5e7`) with green border (`#a6da95`)
- Pattern name (12px, semibold) on the left
- Match percentage (10px, green, semibold) on the right
- Grok pattern preview in monospace (9px, muted): `%{SYSLOGTIMESTAMP:timestamp} %{SYSLOGHOST:host} ...`
- Rounded corners (6px), padding 8-10px
- "SELECTED" label above (9px, muted, uppercase)

Alternative patterns as clickable rows:

- White background, subtle border on hover
- Pattern name (10px, medium weight)
- Match percentage with colored text (green for high, amber for mid, red for low)
- No match bar — simplicity over clutter

"More patterns →" link at bottom (10px, accent color):

- Opens the existing `LogPatternSelection.tsx` component as a searchable dropdown or modal
- Selecting a pattern updates the detail panel and preview

"Write custom pattern →" link at bottom (10px, accent color):

- Opens the existing `CustomPatternSelector.tsx` component
- Can be a slide-out within the detail panel or a full modal
- Saving a custom pattern triggers the existing `SavePatternDialog.tsx` after import

### Timestamp Tab

**Mockup:** `mockups/timestamp-tab.html` (Option B chosen)

Status badge at top:

- "✓ Detected" (green background `#e7f5e7`, green border, 11px semibold)
- Resolved format: `Jun 15 14:31:22` (monospace, 10px)
- Format string: `%b %d %H:%M:%S` (9px, muted)
- When ambiguous: amber background with "⚠ Timestamp is ambiguous" + clickable format options (e.g., "MM/DD/YYYY" / "DD/MM/YYYY")

Resolution tiles grid (2x2, always visible):

```
┌─────────┬─────────┐
│ YEAR    │ MONTH   │
│ 2026    │ Jun     │
│ from log│ from log│  ← color-coded provenance
├─────────┼─────────┤
│ DAY     │ TZ      │
│ 15      │ UTC     │
│ from log│ inferred│
└─────────┴─────────┘
```

Each tile:
- Rounded corners (4px), padding 6px
- Colored background: green (`#e7f5e7`) for "from log", amber (`#fff6e6`) for "inferred/forced", gray (`#e6e9ef`) for "missing"
- Label (8px, muted, uppercase)
- Value (12px, semibold)
- Provenance line (8px, matching the color)
- Clickable to open its override picker (year: parsed/file date/this year/custom; month: dropdown; day: dropdown; timezone: searchable dropdown)

"Apply timestamp settings to all files" link at bottom (10px, accent color)

### Options Tab

**Mockup:** `mockups/options-import.html` (left-hand options content in both variants)

Three configuration groups:

**Smart Decoder:**
- Row with label + description + toggle switch on the right
- Label: "Smart decoder" (10px, semibold)
- Description: "Auto-detect JSON/CSV inside log lines" (9px, muted)
- Toggle: shadcn/ui Switch component, accent blue when on
- Default: off (match current behavior)

**Force Timezone:**
- Label: "Force timezone" (10px, semibold)
- Description: "Override the timezone from auto-detection" (9px, muted)
- Dropdown selector below, full width: "Auto (from detection)" as default, then common timezones (UTC, US/Eastern, US/Pacific, Europe/London, Europe/Zurich, etc.)
- Uses shadcn/ui Select component

**Multiline Records:**
- Label: "Multiline records" (10px, semibold)
- Description: "Join continuation lines to the record above" (9px, muted)
- Chip-style mode selector below: Off | Indent-based | ISO8601 | Syslog | Regex
  - Selected chip: accent blue background with white text OR blue border on white
  - Unselected chips: white background with subtle border
  - 10px text, 3px padding, 4px gap
- When "Regex" is selected: show a text input below for the continuation pattern
  - Placeholder: "e.g., ^\\s+|^\\d{4}-" (9px, monospace)
  - Full width within the panel

"Apply these options to all files" link at bottom (10px, accent color)

---

## Upload Progress

**Mockup:** `mockups/progress-success.html` (Option B chosen)

### Visual Design (Centered)

- The file list and preview panels fade/recede (or the left panel content is replaced entirely)
- Centered progress area:
  - Animated icon (spinner/hourglass, 24px, accent blue)
  - "Importing N files" heading (14px, semibold)
  - "M of ~T lines" count (12px, muted)
  - Single progress bar:
    - Width: approx 80% of the centered area
    - Height: 6px
    - Background: `#e6e9ef`, rounded 3px
    - Fill: accent blue (`#1e66f5`), animated transition
  - "Show per-file details ▼" expandable link (10px, accent color)
    - When expanded: shows each file's status row
      - ✓ (green) completed files: file name + line count
      - ● (blue pulsing) current file: file name + "M / T" count
      - ○ (gray) queued files: "queued"
    - Shows error messages inline for failed files (red, 10px)
  - "Cancel import" button (10px, red `#d20f39`, centered)

### Behavior

- Clicking "Import N files" transitions to this state immediately
- The existing `useUpload.ts` hook drives all progress data
- For browser uploads: chunked file reads update per-file progress
- For native path uploads: SSE `ingest_progress` events update per-file progress
- "Cancel import" calls the abort controller and `DELETE /ingest/jobs/{id}` for any running jobs
- If cancel fails on a job, attempt to end the session gracefully and show partial results

---

## Success / Completion

**Mockup:** `mockups/progress-success.html` (bottom section of Option B)

### Visual Design

Replaces the progress area, same centered position:

- Green checkmark icon (✓, 24px, `#40a02b`)
- "Import complete" heading (13px, semibold)
- "N files · T lines" summary (11px, green text `#1e5500`)
- "Redirecting to home in 5s…" countdown (11px, muted)
- "View in LogSonic →" link (11px, accent color) — immediately navigates, skipping countdown

The entire success block uses a light green background (`#e7f5e7`) with a green border (`#a6da95`), rounded corners (6px), cand 16px padding.

### Behavior

- After countdown expires OR user clicks "View in LogSonic →":
  - Call `store.reset()`
  - Call `useSystemInfoStore.refresh()` or equivalent
  - Navigate to `/` (home)
- If there were failures (partial success):
  - Icon changes to ✓ + ✗ combo
  - Show "N succeeded · M failed" instead of "N files"
  - Show a brief per-file breakdown of failed files with error messages
  - No auto-redirect — user must click "View in LogSonic →"

---

## Error Handling

### File-Level Errors

| Error | Where shown | Visual |
|-------|-------------|--------|
| Invalid file type | Toast on drop | Red toast, 3s auto-dismiss |
| File too large (> 5 GiB) | Toast on drop | Red toast with size limit |
| Duplicate file | Silent ignore | No UI; the file just doesn't appear twice |
| Detection failed | File row + detail panel | Red status dot, "Detection failed — retry" in detail panel |
| Upload failed (per-file) | Expandable progress details | Red X + error message inline |
| Upload timeout | Progress area | Amber warning + "Taking longer than expected…" after 30s |

### Validation States (Import button disabled)

| Condition | Button text / reason |
|-----------|---------------------|
| No files selected | "Add files to import" (button hidden or fully disabled) |
| Files with no pattern | "All files need a pattern — 1 pending" |
| Ambiguous timestamps unconfirmed | "Resolve ambiguous timestamps before importing" |
| Custom pattern with invalid multiline header | "Fix multiline header regex" |
| Upload already in progress | Button replaced with progress UI |

### Network / Server Errors

- Pattern detection failure: "Detection failed — retry" with retry button in the file row
- Upload interruption: The progress area shows failed files. Users can retry individual failed files or the whole batch.
- Never show a frozen spinner. Always show either progress, retry, or error state.

---

## Store Changes

The existing Zustand store (`useImportStore.ts`, 660 lines) is simplified:

### Remove

- `currentStep`, `setCurrentStep`, and all wizard-step navigation logic
- Legacy single-file state: `selectedFileName`, `filePreviewBuffer` — all paths use the multi-file `files: ImportFile[]`
- `importSource` / `readyToSelectPattern` — selection is now per-file via the detail panel
- `approxLines`, `totalLines` — per-file line counts already exist in `ImportFile`

### Add

```typescript
// Detail panel state
detailPanelFileId: string | null;
openFileDetail(fileId: string): void;
closeFileDetail(): void;

// Upload progress UI state
isExpandedPerFileDetails: boolean;
togglePerFileDetails(): void;

// Batch operations
setAllFilesPattern(pattern: Pattern): void;          // existing, keep
setAllFilesTimestamp(config: TimestampResolution): void;  // existing, keep
setAllFilesOptions(options: FileSessionOptions): void;    // new
```

### Keep (Unchanged)

- `files: ImportFile[]` with all per-file fields (detection, pattern, upload status, timestamp state)
- All file management actions: `addFiles`, `addNativePathFiles`, `removeFile`, `updateFile`, `getActiveFile`
- All pattern actions: `handlePatternOperation`, `testPattern`, fetch available patterns
- All timestamp actions: `setFileTimestampInference`, `patchFileTimestampOverride`, `applyTimestampToAllFiles`
- All session option actions
- Upload hooks (`useUpload`, `ingestJobEvents`) — unchanged, driven by the same store shape
- `reset()` — clear all state on navigation away

---

## Component Architecture

```
pages/Import.tsx                     [rewrite] — page shell, drop state, upload orchestration

components/Import/
├── ImportLayout.tsx                 [new] — full-width shell: drop strip + split pane container
│
├── DropZone.tsx                     [rewrite] — two modes controlled by hasFiles prop:
│                                       empty= tall centered zone; hasFiles= compact top strip
│
├── FileList/                        [new]
│   ├── FileList.tsx                 — scrollable rows + batch actions + import footer
│   └── FileRow.tsx                  — individual row: icon, name, size, pattern, status dot,
│                                     configured icon. selection onClick, config onClick.
│
├── DetailPanel/                     [new]
│   ├── DetailPanel.tsx              — container with Back link, file header, tab bar
│   ├── PatternTab.tsx               — selected card + alternative chips + More/Custom links
│   ├── TimestampTab.tsx             — status badge + tiles grid + ambiguous prompt
│   └── OptionsTab.tsx               — Smart Decoder toggle + timezone select + multiline chips
│
├── PreviewPane/                     [new]
│   └── PreviewPane.tsx              — monospace lines + field highlighting + line numbers
│
├── UploadProgress/                  [new]
│   ├── UploadProgress.tsx           — centered spinner + progress bar + expandable details
│   └── UploadFileRow.tsx            — per-file status row: icon, name, count, error
│
├── SuccessSummary.tsx               [rewrite] — green banner + countdown + link + partial stats
│
├── hooks/
│   ├── useUpload.ts                 [keep, minor prop adjustments]
│   └── ingestJobEvents.ts           [keep]
│
├── utils/
│   └── patternUtils.tsx             [keep]
│
└── types/
    └── index.ts                     [update types: remove step types, add panel/detail types]

Reused with minimal changes:
├── UploadSteps/CustomPatternSelector.tsx   — in PatternTab for "Write custom pattern"
├── UploadSteps/SavePatternDialog.tsx        — triggered after import for custom patterns
├── UploadSteps/PatternTestResults.tsx      — in PreviewPane for pattern testing
├── UploadSteps/TimestampBuilder.tsx        — in TimestampTab for the tiles grid
├── UploadSteps/LogPatternSelection.tsx     — "More patterns" searchable dropdown
└── LocalFileImport/FileSelectionService.ts — file reading (unchanged)

Removed:
├── UploadSteps/FileAnalyzingStep.tsx       → split into FileList + DetailPanel + PreviewPane
├── UploadSteps/UploadingStep.tsx            → replaced by UploadProgress
├── UploadSteps/LogSourceSelectionStep.tsx   → no wizard steps
├── UploadSteps/HandleNavigation.tsx         → no wizard navigation
├── UploadSteps/TimestampToolbar.tsx         → merged into TimestampTab
├── UploadSteps/IngestSessionOptions.tsx     → replaced by OptionsTab
└── UploadSteps/StatusBanner.tsx             → replaced by inline status components
```

---

## API Contract

No new API endpoints. All existing endpoints are reused.

| Endpoint | Used for | Caller |
|----------|----------|--------|
| `POST /parse` | Auto-detect patterns, test custom patterns | PatternTab, PreviewPane |
| `POST /parse/preview-file` | Read preview lines from native-path files | DropZone (on native path drop) |
| `POST /timestamp/preview` | Live timestamp re-preview on knob changes | TimestampTab (debounced) |
| `GET /grok` | List saved Grok patterns | PatternTab |
| `POST /grok` | Save custom pattern | SavePatternDialog (post-import) |
| `POST /ingest/start` | Start ingest session | useUpload hook |
| `POST /ingest/logs` | Send chunk of log lines (browser upload) | useUpload hook |
| `POST /ingest/end` | Close ingest session | useUpload hook |
| `POST /ingest/file` | Server-side path-based ingest (native) | useUpload hook |
| `GET /ingest/jobs` | List active ingest jobs (SSE reconnect) | ingestJobEvents hook |
| `DELETE /ingest/jobs/{id}` | Cancel a running ingest job | UploadProgress cancel |
| `GET /api/v1/live/events` | SSE for native-path ingest progress | ingestJobEvents hook |

---

## Platform Considerations

### Browser Mode

- Files arrive as `File` objects (drag-and-drop or file picker)
- Preview lines read via `FileSelectionService.readFilePreview()` (reads first 1MB, up to 100 non-empty lines)
- Upload uses chunked streaming: `FileSelectionService.streamFileChunks()` → `POST /ingest/logs` per chunk (10k lines per call)
- Progress tracked client-side via chunk callbacks

### Native Mode (macOS)

- Files arrive as absolute paths via `window.__logsononicPendingNativeFiles` + `logsonic-native-files` CustomEvent
- Preview lines read via `POST /parse/preview-file` (server reads the file)
- Upload uses `POST /ingest/file` (202 Accepted) → progress via SSE `ingest_progress` events
- Server handles gzip/zstd compression and rotated file sets

### Both modes — same surface

The UI does not change between modes. The only behavioral difference is:
- How preview data arrives (`readFilePreview` vs. `POST /parse/preview-file`)
- How progress is tracked (client callbacks vs. SSE events)
- The `ImportFile` type has mutually exclusive `file: File` (browser) and `nativePath: string` (native) fields

---

## Constraints

- Must support the same file types: `.log`, `.txt`, `.json` (and MIME `text/plain`, `application/json`)
- Max 5 GiB per file (browser mode)
- Auto-detection must run in parallel for all files immediately on drop (currently sequential)
- The custom pattern editor (dnd-kit token chips from `CustomPatternSelector.tsx`) must remain accessible
- The "Save Pattern" dialog must still fire after import when a custom pattern was used
- Must integrate with the sources catalog (`now-10`) — imported files become sources visible in the catalog
- No new API endpoints — reuse the existing 12 endpoints
- Must not break the existing `ImportFile` type contract used by `useUpload.ts` and `useImportStore.ts`
- Component reuse: `CustomPatternSelector`, `SavePatternDialog`, `PatternTestResults`, `TimestampBuilder`, `LogPatternSelection`, `FileSelectionService` must be reused with minimal changes

---

## Out of Scope

- Container sources (Docker/K8s) — `specs/next-02-container-sources.md`
- OTLP ingest — `specs/next-01-otlp-ingest.md`
- Case files — `specs/next-07-case-files.md`
- Adding new source types beyond file import
- Pattern clustering — `specs/next-03-pattern-clustering.md`
- The sources catalog UI itself — `specs/now-10-sources-catalog.md` (this spec is the import entry point INTO the catalog)
- Multi-user / team features — `specs/later-charters.md` L1

---

## Related Specs

- `specs/now-08-native-path-import.md` — Native path file import via shell drops
- `specs/now-10-sources-catalog.md` — Sources catalog, persisted source tracking
- `specs/next-02-container-sources.md` — Container log sources (future import source type)
- `specs/next-01-otlp-ingest.md` — OTLP ingest (future import source type)