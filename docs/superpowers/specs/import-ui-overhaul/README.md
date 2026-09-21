# Import UI Overhaul — Designer's Package

## What's in this folder

```
import-ui-overhaul/
├── README.md               ← You are here
├── spec.md                 ← Functional specification (the master doc)
├── mockups/                ← Visual wireframes from brainstorming
│   ├── approaches.html         A vs B — the two competing layouts
│   ├── settings-panels.html    Pattern config: expand, panel, or popover?
│   ├── empty-state.html        Three empty-state + layout variants
│   ├── detail-panel.html       Pattern tab: one-click vs searchable list
│   ├── timestamp-tab.html      Timestamp tab: simple vs full builder
│   ├── options-import.html     Options tab + Import CTA placement
│   └── progress-success.html   Upload progress + completion states
└── (zip this folder to share)
```

## How to use this

1. **Read `spec.md` first** — it's the source of truth. Covers requirements, component architecture, data flow, states, and constraints.
2. **Open the mockups in a browser** — each `.html` file is a standalone page. The chosen option is called out in the spec. Open them side-by-side with the spec to see both the written intent and the visual direction.
3. **The chosen direction is:** split-pane "Inspect & Commit" layout with an expanding sheet, detail panel replacing the file list, full timestamp builder, sticky import CTA, and centered progress/success states.

## Design decisions at a glance

| Question | Chosen |
|----------|--------|
| Overall layout | Split-pane: 40% file list + 60% preview |
| Empty → files transition | Tall drop zone → compact strip + expanding sheet |
| Per-file settings | Detail panel replacing file list (Pattern / Timestamp / Options tabs) |
| Pattern tab | Prominent detected card + alternative chips |
| Timestamp tab | Full builder tiles grid always visible |
| Options tab | 3 toggle groups: Smart Decoder, Timezone, Multiline |
| Import CTA location | Sticky footer in the file list panel |
| Upload progress | Centered progress bar + expandable per-file details |
| Completion | Green banner + 5s countdown auto-redirect |

## Tech context

- **Project:** LogSonic — a local-first desktop log viewer
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui (Radix UI), Zustand
- **Routing:** `#/import` (HashRouter, React Router v7)
- **Existing import code:** `/frontend/src/components/Import/` and `/frontend/src/pages/Import.tsx`
- **Spec references:** `specs/now-08-native-path-import.md`, `specs/now-10-sources-catalog.md`

Questions? Reach out to the LogSonic team.