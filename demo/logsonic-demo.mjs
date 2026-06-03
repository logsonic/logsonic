#!/usr/bin/env node
/**
 * LogSonic UI demo — drives the real web UI through Playwright so the whole
 * flow (empty → import wizard → search) can be screen-recorded with Kap.
 *
 * It is intentionally headed and slowed down so the cursor and each click are
 * visible on screen. Nothing here hits the ingest API directly — every step
 * goes through the same UI a user would click.
 *
 * Prereqs (run these yourself first):
 *   backend : cd backend  && go run main.go -port 8080
 *   frontend: cd frontend && PORT=8081 npm run dev
 *
 * Run:
 *   cd frontend && node ../demo/logsonic-demo.mjs
 *
 * Env knobs:
 *   FRONTEND   default http://localhost:8081
 *   BACKEND    default http://localhost:8080
 *   FILES      comma-separated log paths to import (default: linux-syslog + apache)
 *   FEATURE    basename of the file to expand on camera (default: first FILES entry)
 *   SEARCH1/2  the two closing search queries (default: "authentication failure", "error")
 *   CLEAR      "0" to keep existing logs (default: clears first for a clean run)
 *   WINDOW     "WIDTH,HEIGHT" window size (default fills the main display height)
 *   WINDOW_POS "X,Y" window top-left in the multi-display space (default "0,0").
 *              Target a second screen by its origin, e.g. "-1723,-2160".
 *   FULLSCREEN "1" to use the whole screen with no browser chrome (max height)
 *   MAXIMIZE   "1" to maximize to the screen the window opens on
 *   SLOWMO     ms between actions (default 350)
 *   STEPDELAY  ms beat between import-wizard steps (default 2200)
 *   PATTERN_FILTER  text typed into the Settings pattern filter (default
 *              derived from the first row, falling back to "grok")
 *   STARTDELAY seconds to wait once the UI is up (browser open on the home
 *              page) before the demo actions begin, so you can frame Kap and
 *              start recording (default 10; set 0 to skip)
 *   KEEP_OPEN  "1" to leave the browser open at the end (default closes)
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// playwright is installed in frontend/node_modules — resolve it from there so
// this script works regardless of the cwd it's launched from.
const require = createRequire(path.join(REPO, 'frontend', 'node_modules', '_'));
const { chromium } = require('playwright');

const FRONTEND = process.env.FRONTEND ?? 'http://localhost:8081';
const BACKEND = process.env.BACKEND ?? 'http://localhost:8080';
const SLOWMO = Number(process.env.SLOWMO ?? 350);
const STARTDELAY = Number(process.env.STARTDELAY ?? 10);
// Beat between import-wizard steps so each one is clearly visible on screen.
const STEPDELAY = Number(process.env.STEPDELAY ?? 2200);
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const CLEAR = process.env.CLEAR !== '0';
// Closing demo searches. SEARCH1 hits the syslog logs inside the default time
// window; SEARCH2 ("error") matches the apache logs, which are dated 2005 and
// fall outside the window — so the demo then clicks "Fit time range" to reveal
// them.
const SEARCH1 = process.env.SEARCH1 ?? 'authentication failure';
const SEARCH2 = process.env.SEARCH2 ?? 'error';
// Row-coloring rule demonstrated on camera: highlight rows where COLOR_FIELD
// contains COLOR_VALUE (the syslog "program" field holds values like
// "sshd(pam_unix)", so this lights up the SSH auth rows).
const COLOR_FIELD = process.env.COLOR_FIELD ?? 'program';
const COLOR_VALUE = process.env.COLOR_VALUE ?? 'sshd';
const DARK = process.env.DARK !== '0';
// Sample text typed into the Settings → Custom patterns filter box. Defaults
// are derived from a real row at runtime; this is the fallback.
const PATTERN_FILTER = process.env.PATTERN_FILTER ?? 'grok';

// Plain-text logs (no JSON). linux-syslog.log is deliberately year-less so the
// wizard flags its timestamps as "Ambiguous" — that's what lets the demo show
// the timestamp-correction panel and the "Looks correct" confirm gate. The
// FEATURE file (below) is the one we expand to show settings/correction.
const FILES = (process.env.FILES
  ? process.env.FILES.split(',')
  : ['sample-logs/linux-syslog.log', 'sample-logs/apache.log']
).map((f) => (path.isAbsolute(f) ? f : path.join(REPO, f.trim())));
// File whose detail panel we open on camera (default: the first one).
const FEATURE = path.basename(
  process.env.FEATURE ? process.env.FEATURE.trim() : FILES[0],
);

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const pause = (page, ms) => page.waitForTimeout(ms);
const step = (page) => page.waitForTimeout(STEPDELAY);

async function main() {
  if (CLEAR) {
    log('Clearing existing logs for a clean start…');
    try {
      const res = await fetch(`${BACKEND}/api/v1/logs`, { method: 'DELETE' });
      log(`  cleared (HTTP ${res.status})`);
    } catch (e) {
      console.warn(`  could not clear logs: ${e.message}`);
    }
  }

  // Window placement & size. viewport:null lets the page use the full window.
  //   WINDOW_POS  "X,Y" top-left in the global multi-display space (default
  //               "0,0"). To target a secondary screen, pass its origin — e.g.
  //               the 5K display above the main one starts at "-1723,-2160".
  //   FULLSCREEN=1  use the whole screen, no browser chrome (max height).
  //   MAXIMIZE=1    maximize to the screen the window opens on.
  //   WINDOW      "W,H" explicit size (default fills the main display height).
  const POS = process.env.WINDOW_POS ?? '0,0';
  const launchArgs = [`--window-position=${POS.replace(/\s/g, '')}`];
  if (process.env.FULLSCREEN === '1') {
    launchArgs.push('--start-fullscreen');
  } else if (process.env.MAXIMIZE === '1') {
    launchArgs.push('--start-maximized');
  } else {
    // A touch over the display height so Chrome clamps to the tallest window
    // the OS allows (taller than --start-maximized's menu-bar gap).
    const [w, h] = (process.env.WINDOW ?? '1728,1200')
      .split(',')
      .map((n) => parseInt(n, 10));
    launchArgs.push(`--window-size=${w},${h}`);
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: SLOWMO,
    args: launchArgs,
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // ── 1. Home (empty state) ───────────────────────────────────────────────
  log('Opening LogSonic home…');
  await page.goto(`${FRONTEND}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  // App/UI is now up and visible — give the user time to frame Kap on the
  // window and start recording before the demo actions begin.
  if (STARTDELAY > 0) {
    log(`UI ready — start your Kap recording. Actions begin in ${STARTDELAY}s…`);
    for (let s = STARTDELAY; s > 0; s--) {
      process.stdout.write(`\r\x1b[36m▸\x1b[0m   ${s}s … `);
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdout.write('\r\x1b[36m▸\x1b[0m   go!        \n');
  }
  await pause(page, 800);

  // ── 2. Into the Import wizard ───────────────────────────────────────────
  log('Opening the Import wizard…');
  const importRail = page.getByRole('button', { name: 'Import', exact: true });
  if (await importRail.count()) {
    await importRail.first().click();
  } else {
    await page.goto(`${FRONTEND}/#/import`, { waitUntil: 'domcontentloaded' });
  }
  await page.getByText('Import logs', { exact: true }).waitFor({ timeout: 10000 });
  await step(page);

  // ── 3. Select files (step 1) ────────────────────────────────────────────
  log(`Selecting ${FILES.length} log file(s): ${FILES.map((f) => path.basename(f)).join(', ')}`);
  await page.locator('input[type="file"]').first().setInputFiles(FILES);
  // Let the viewer see the selected files land before advancing.
  await step(page);

  // File selection auto-advances to step 2; if it didn't, click Next.
  const nextBtn = page.getByRole('button', { name: 'Next', exact: true });
  if (await nextBtn.isVisible().catch(() => false)) {
    if (await nextBtn.isEnabled().catch(() => false)) await nextBtn.click();
  }
  await step(page);

  // ── 4. Step 2: wait for auto-detection to settle ────────────────────────
  log('Waiting for pattern auto-detection…');
  const importBtn = page.getByRole('button', { name: /^Import(\s+\d+\s+File)?/ });
  await importBtn.waitFor({ timeout: 15000 });
  // Detection is done once either the Import button is enabled (all clean) or a
  // Settings button has appeared (a file auto-expanded for a timestamp issue).
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('button')];
    const imp = btns.find((x) => /^Import(\s+\d+\s+File)?/.test(x.textContent?.trim() ?? ''));
    const ready = imp && !imp.disabled;
    const hasSettings = btns.some((x) => /Settings/.test(x.textContent ?? ''));
    return ready || hasSettings;
  }, { timeout: 25000 }).catch(() => {});
  await step(page);

  // ── 4b. Click the file → open settings → show timestamp correction ──────
  // Toggle the featured file's row open. The year-less syslog file may have
  // auto-expanded already; if our click collapsed it, click once more so it
  // ends up open regardless of the starting state.
  log(`Clicking "${FEATURE}" to open its detail…`);
  const fileRow = page.getByText(FEATURE).first();
  await fileRow.scrollIntoViewIfNeeded().catch(() => {});
  await fileRow.click();
  await pause(page, 600);
  let settingsBtn = page.getByRole('button', { name: /Settings/ }).first();
  if (!(await settingsBtn.isVisible().catch(() => false))) {
    await fileRow.click();
    await pause(page, 600);
    settingsBtn = page.getByRole('button', { name: /Settings/ }).first();
  }
  await step(page);

  if (await settingsBtn.isVisible().catch(() => false)) {
    log('Opening timestamp settings & correction…');
    await settingsBtn.scrollIntoViewIfNeeded().catch(() => {});
    await settingsBtn.click();
    await step(page);
    await step(page); // linger on the timestamp-correction controls
  } else {
    log('  (Settings button not found — skipping timestamp panel)');
  }

  // Year-less timestamps gate the import until confirmed. Click "Looks
  // correct" on any file that's asking for confirmation.
  const confirmBtn = page.getByRole('button', { name: 'Looks correct' });
  if (await confirmBtn.first().isVisible().catch(() => false)) {
    log('Confirming the resolved timestamps…');
    await confirmBtn.first().scrollIntoViewIfNeeded().catch(() => {});
    await confirmBtn.first().click();
    await step(page);
  }

  // ── 4c. Import (now that any gate is cleared) ───────────────────────────
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /^Import(\s+\d+\s+File)?/.test(x.textContent?.trim() ?? ''));
    return b && !b.disabled;
  }, { timeout: 15000 }).catch(() => log('  (Import still gated — check timestamp step)'));

  log('Importing…');
  await importBtn.scrollIntoViewIfNeeded().catch(() => {});
  await importBtn.click();
  await step(page);

  // ── 5. Step 3: success summary → Home ───────────────────────────────────
  const homeBtn = page.getByRole('button', { name: 'Home', exact: true });
  await homeBtn.waitFor({ timeout: 30000 });
  log('Import complete — viewing summary.');
  await step(page);
  await homeBtn.click();
  await step(page);

  // Small helper: click a left-rail / header button by its accessible name.
  const clickByName = async (name) => {
    const b = page.getByRole('button', { name, exact: true }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      return true;
    }
    return false;
  };

  // ── 6. Dark mode (show it briefly, then revert to light) ────────────────
  if (DARK) {
    log('Switching to dark mode (Moon icon)…');
    if (await clickByName('Toggle theme')) {
      await pause(page, 3000); // hold on dark mode for 3s
      log('Reverting to light mode…');
      await clickByName('Toggle theme');
      await step(page);
    } else {
      log('  (theme toggle not found)');
    }
  }

  // ── 7. Search the freshly-imported logs ─────────────────────────────────
  log(`Searching "${SEARCH1}"…`);
  // The placeholder changes once the box is focused, so locate it while
  // unfocused, then drive it with the keyboard (no focus-dependent locator).
  const search = page.getByPlaceholder(/Search logs/i);
  await search.waitFor({ timeout: 10000 });
  await pause(page, 800);
  await search.click();
  await page.keyboard.type(SEARCH1, { delay: 45 });
  await pause(page, 400);
  await page.keyboard.press('Enter');
  await pause(page, 2500);

  // ── 8. Coloring rule: highlight rows where COLOR_FIELD contains COLOR_VALUE
  log(`Adding a row-coloring rule (${COLOR_FIELD} contains "${COLOR_VALUE}")…`);
  try {
    await clickByName('Row coloring');
    await step(page);
    await page.getByRole('button', { name: 'Add rule', exact: true }).click();
    await pause(page, 800);
    // Field (Radix Select → options render as role=option)
    await page.locator('#rule-field').click();
    await page.getByRole('option', { name: COLOR_FIELD, exact: true }).first().click();
    await pause(page, 500);
    // Operator → Contains
    await page.locator('#rule-operator').click();
    await page.getByRole('option', { name: 'Contains', exact: true }).click();
    await pause(page, 500);
    // Value
    await page.locator('#rule-value').fill(COLOR_VALUE);
    await pause(page, 500);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await step(page); // linger so the highlighted rows are visible
  } catch (e) {
    log(`  (coloring step skipped: ${e.message.split('\n')[0]})`);
  }
  await clickByName('Row coloring'); // collapse the panel
  await pause(page, 800);

  // ── 9. Refine the search → out of range → Fit time range ────────────────
  log(`Searching "${SEARCH2}"…`);
  await search.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(SEARCH2, { delay: 45 });
  await pause(page, 400);
  await page.keyboard.press('Enter');
  await pause(page, 2500);

  // The apache logs are dated 2005, outside the default time window, so this
  // search lands outside the range and shows "No logs match the current
  // filters." Click "Fit time range…" to snap the window to the indexed data
  // and reveal the results.
  const fitBtn = page.getByRole('button', { name: /Fit time range/i });
  if (await fitBtn.first().isVisible().catch(() => false)) {
    log('Out-of-range results — clicking "Fit time range" to reveal them…');
    await fitBtn.first().scrollIntoViewIfNeeded().catch(() => {});
    await fitBtn.first().click();
    await pause(page, 3000);
  }

  // ── 10. Filters: toggle a source off and back on ────────────────────────
  log('Opening the Filters panel and toggling a source…');
  try {
    await clickByName('Filters');
    await step(page);
    // Source rows render a <label for="source-...">; clicking it filters that
    // source out of the results. (Both the row and checkbox handlers set the
    // same target state, so one click is one clean toggle.)
    const srcLabel = page.locator('label[for^="source-"]').first();
    await srcLabel.waitFor({ timeout: 5000 });
    await srcLabel.click(); // deselect → that source drops out
    await step(page);
    await srcLabel.click(); // reselect → it comes back
    await step(page);
  } catch (e) {
    log(`  (filters step skipped: ${e.message.split('\n')[0]})`);
  }
  await clickByName('Filters'); // collapse the panel
  await pause(page, 1500);

  // ── 11. Settings → Custom patterns (view, filter, export & import) ───────
  log('Opening Settings → Custom patterns…');
  if (!(await clickByName('Settings'))) {
    await page.goto(`${FRONTEND}/#/settings/patterns`, { waitUntil: 'domcontentloaded' });
  }
  try {
    await page.getByRole('heading', { name: 'Custom patterns' }).waitFor({ timeout: 10000 });
    await step(page); // linger on the patterns table

    // Filter the table by a term taken from a real row (so it always matches),
    // then clear it.
    const firstCell = await page
      .locator('.ls-dtable tbody tr td')
      .first()
      .textContent()
      .catch(() => '');
    const filterTerm = (firstCell?.match(/[A-Za-z]+/)?.[0] ?? PATTERN_FILTER).slice(0, 5);
    log(`Filtering patterns by "${filterTerm}"…`);
    const pfilter = page.getByPlaceholder(/Filter patterns/i);
    if (await pfilter.isVisible().catch(() => false)) {
      await pfilter.click();
      await page.keyboard.type(filterTerm, { delay: 55 });
      await step(page);
      await pfilter.fill('');
      await pause(page, 600);
    }

    // Open the editor on the first pattern to show the edit dialog, then close.
    log('Opening the pattern editor…');
    const editBtn = page.getByRole('button', { name: /^Edit / }).first();
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click();
      await step(page);
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      await pause(page, 600);
    }

    // Export every pattern to a versioned JSON file…
    log('Exporting patterns to JSON…');
    const [download] = await Promise.all([
      page.waitForEvent('download').catch(() => null),
      page.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    await step(page);

    // …then re-import that same file to show the upsert round-trip.
    const exportPath = download ? await download.path().catch(() => null) : null;
    if (exportPath) {
      log('Re-importing the exported file (upsert round-trip)…');
      await page.locator('input[type="file"]').first().setInputFiles(exportPath);
      await page
        .getByText(/Import complete|Import finished/i)
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await step(page);
    } else {
      log('  (download not captured — skipping re-import)');
    }
  } catch (e) {
    log(`  (settings step skipped: ${e.message.split('\n')[0]})`);
  }

  log('Demo flow complete.');
  if (KEEP_OPEN) {
    log('KEEP_OPEN set — leaving the browser open. Ctrl+C to exit.');
    await new Promise(() => {});
  } else {
    // Hold on the final view for 5s before closing so the recording can linger.
    await pause(page, 5000);
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\x1b[31mDemo failed:\x1b[0m', err);
  process.exit(1);
});
