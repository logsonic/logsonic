# LogSonic investigation UI refresh

The brief: improve the existing frontend using current agent-tool interaction
patterns. The chat started above the logs; on 2026-10-28 it moved to a
right-hand dock beside them. MCP UI controls are unchanged.

## Direction

Claude Code's desktop redesign keeps chat, previews and review surfaces in the
same workspace and offers levels of activity detail. Cursor keeps task progress
and review in the agent panel. LogSonic applies those principles to log evidence:
conversation beside the actual events, action details available on demand.

References inspected:
- https://claude.com/blog/claude-code-desktop-redesign
- https://cursor.com/docs/agent/overview

The visual language uses cool neutral surfaces, graphite text, and the existing
violet identity for selected actions. System sans type keeps native macOS
rendering; timestamps and identifiers retain monospace. No remote font requests.

## Changes

- The agent is a right-hand dock (Cmd/Ctrl+J) beside the log view, replacing the
  earlier Search / Agent switch. Import and Agent sit in the header.
  Navigation groups primary modes, inspection tools, then
  import/settings.
- The Agent dock is resizable, streams its replies and keeps a history of
  investigations. Its action trail links each step to the table. Safe
  Markdown renders prose, code and tables without executing HTML.
- Tool activity uses human labels, real result summaries and optional exact
  input/output. Steps stream in as they start and finish; a spinner marks the running step.
- Header utilities live in a workspace menu. Existing deletion confirmation
  remains intact. Light and dark themes use the same hierarchy.
- Log rows use restrained severity cues and compact badges rather than saturated
  full-row backgrounds. Message prose uses sans type; structured data stays
  monospaced. Column controls and chart headings use clearer labels.

## Validation

Frontend tests, TypeScript and production build; live Claude/MCP command round
trip, retained query/chat across mode switches, workspace-menu deletion guard
(cancel only), keyboard focus, light/dark screenshots and narrow viewport review.
No ingestion, proxy, storage, or analysis behavior is replaced by the redesign.

Verified result: 35 frontend test files / 390 tests pass, TypeScript passes,
production build passes. The real Claude/MCP browser demo applied the requested
source/time/filter/column changes and showed six matching rows while preserving
chat and search state. The workspace menu retained the protected deletion dialog;
the check opened and cancelled it without deleting data. Reviewed light/dark
screenshots and a 390px mobile layout with no toolbar/pagination overlap.

Current screenshots are under `/tmp/logsonic-agent-demo-artifacts`:
`agent-ui-controlled.png`, `redesign-dark.png`, and
`redesign-mobile-responsive.png`. The live UI remains at
http://127.0.0.1:5173/#/agent. Changes are uncommitted.
