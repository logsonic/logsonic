# now-01 — Remove the Google Fonts import (self-hosted / system fonts)

**Horizon:** Now (v1.7) · **Size:** S (an afternoon) · **Priority:** P0
**TBD.md ref:** §2 defect table, §5 v1.7 trust sprint, §7 Type & density, §9 (verifiable "no network calls").
**Read `specs/README.md` first** for dev setup and codebase map.

## Goal

`frontend/src/index.css` line 1 imports Geist / Geist Mono from `fonts.googleapis.com`. This contradicts the README's headline promise — "No telemetry. No cloud. No network calls." — fails a packet-capture audit, and silently degrades typography offline, including inside the native macOS WKWebView. After this task, **the app makes zero network requests to any non-loopback host**, verified by test.

## Design decision (made — do not re-litigate)

**Adopt the platform system font stack. Do not vendor Geist woff2 files.**

Rationale: (a) zero bytes added to the embedded binary; (b) faster first paint (no font download/parse at all); (c) native feel on every OS — SF Pro on macOS matches the native-app direction (spec `macos-b1`); (d) no font licensing or asset upkeep. Vendoring Geist is the fallback only if the maintainer overrules.

Stacks to use:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

## Current-state anchors

- `frontend/src/index.css:1` — `@import url('https://fonts.googleapis.com/css2?family=Geist...')`. The token block below it defines the `--ls-*` design system.
- `frontend/tailwind.config.ts` lines ~22–24 — `fontFamily: { montserrat: ['Montserrat', 'sans-serif'] }` (legacy, likely unused).
- Grep targets: `Geist`, `montserrat`, `font-mono`, `font-sans` across `frontend/src/`.

## Step-by-step

1. Delete the `@import` line from `frontend/src/index.css`.
2. Add `--font-sans` and `--font-mono` custom properties to the `:root` token block (they are theme-independent — define once, NOT inside the dark block).
3. Replace every `font-family` reference to Geist / Geist Mono in `index.css`, `App.css`, and both `LogViewer/*.css` files with `var(--font-sans)` / `var(--font-mono)`.
4. In `tailwind.config.ts`, replace the `montserrat` entry with:
   ```ts
   fontFamily: {
     sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
     mono: ['ui-monospace', 'SF Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
   }
   ```
   Then grep for `font-montserrat` usages and change them to `font-sans`.
5. Grep the whole frontend for any other external URL fetched at runtime (`https://` in `src/` and `index.html`): the only allowed remote references are documentation links the user clicks (e.g., GitHub links in Help). `frontend/index.html` must not contain `preconnect`/`fonts.googleapis` tags — remove if present.
6. Check `frontend/dist/` is NOT hand-edited (it's build output; it will regenerate).

## Test cases

| # | Test | How | Pass criterion |
|---|------|-----|----------------|
| T1 | No external hosts in source | `grep -rn "googleapis\|gstatic\|fonts.google" frontend/src frontend/index.html` | zero matches |
| T2 | No external hosts in build | `cd frontend && npm run build && grep -rn "googleapis\|gstatic" dist/` | zero matches |
| T3 | Runtime network audit (manual until now-11 automates it as `e2e-network-audit.mjs`) | Start dev servers (see README), open http://localhost:8081, DevTools → Network tab, hard reload, filter out `localhost`/`127.0.0.1` | zero requests to non-loopback hosts |
| T4 | Fonts render | Visual: chrome text is the platform sans; table timestamps/IDs are monospace | no serif/Times fallback anywhere |
| T5 | Unit tests still pass | `cd frontend && npx vitest run && npm run lint` | green |
| T6 | Offline load | Turn off Wi-Fi (or DevTools → Network → Offline after first load), reload the embedded build (`npm run build:copy`, run backend binary, open http://localhost:8080) | page renders identically |

## Manual validation

1. Compare a screenshot of the search page before/after — layout shifts should be minor (system fonts are slightly different metrics); check the search bar, table, status bar for text overflow or clipped line heights. Adjust `line-height`/`letter-spacing` tokens if the table rows visibly change height.
2. On macOS specifically, confirm SF Pro is being used (DevTools → Computed → font-family shows `-apple-system` resolving).

## Acceptance criteria

- [ ] Zero references to Google Fonts (or any external font host) in source and in `npm run build` output.
- [ ] App fully usable offline with correct typography.
- [ ] All existing vitest + eslint checks pass.
- [ ] No visual regressions beyond expected font-metric differences.

## Out of scope

- README wording changes (covered by now-07).
- The `.is-native-macos` font switching (macos-b1) — after this task the stack is already system-native, so b1's font work reduces to nothing; note that in the PR description.
