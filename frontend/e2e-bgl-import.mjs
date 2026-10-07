/**
 * BGL Supercomputer log import E2E test, against the single-surface Import
 * page (file list + preview pane + "Import 1 file" in the footer).
 *
 * Run against an isolated backend (the test clears all logs):
 *   BASE_URL=http://127.0.0.1:8080 API_URL=http://127.0.0.1:8080/api/v1 node e2e-bgl-import.mjs [--headed]
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_LOGS_DIR = path.resolve(__dirname, '../sample-logs');
const BGL_LOG = path.join(SAMPLE_LOGS_DIR, 'bgl-supercomputer.log');
const BGL_LINES = fs.readFileSync(BGL_LOG, 'utf8').split('\n').filter((l) => l.length > 0).length;
// Pattern detection sees at most this many leading lines (PREVIEW_LINES in
// FileSelectionService.ts).
const PREVIEW_LINES = 1000;

const BASE_URL = process.env.BASE_URL || 'http://localhost:8081';
const API_URL  = process.env.API_URL  || 'http://localhost:8080/api/v1';
const headless = !process.argv.includes('--headed');
const ALL_TIME = 'start_date=2000-01-01T00:00:00Z&end_date=2100-01-01T00:00:00Z';

let passed = 0, failed = 0;

function ok(label)       { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
function fail(label, err){ console.error(`  \x1b[31m✗\x1b[0m ${label}: ${err?.message ?? err}`); failed++; }

async function assert(cond, label) { if (cond) ok(label); else fail(label, new Error('assertion failed')); }

async function clearLogs() {
  try { await fetch(`${API_URL}/logs`, { method: 'DELETE' }); } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 100 });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await context.newPage();

// Capture browser console + network for debugging
const consoleMsgs = [];
const networkErrors = [];
page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('response', r => {
  if (!r.ok() && r.url().includes('/api/')) {
    networkErrors.push(`HTTP ${r.status()} ${r.url()}`);
  }
});

// Lines sent to pattern detection: the /parse call without a grok_pattern.
let detectionLines = null;
page.on('request', r => {
  if (r.method() === 'POST' && r.url().endsWith('/api/v1/parse')) {
    const body = JSON.parse(r.postData() || '{}');
    if (!body.grok_pattern && detectionLines === null) detectionLines = (body.logs || []).length;
  }
});

// Capture full network log for ingest endpoints
const ingestLog = [];
page.on('response', async r => {
  if (r.url().includes('/api/v1/ingest')) {
    try {
      const body = await r.json().catch(() => null);
      ingestLog.push({ url: r.url(), status: r.status(), body });
    } catch {}
  }
});

try {
  await clearLogs();
  console.log('\n\x1b[1m[BGL Import E2E]\x1b[0m');

  // ── Step 1: Open the Import page ─────────────────────────────────────────
  // domcontentloaded, not networkidle: the UI keeps an EventSource open.
  await page.goto(`${BASE_URL}/#/import`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
  ok('Opened Import page');

  // ── Step 2: Add the BGL file (hidden input — set directly) ───────────────
  await page.locator('input[type="file"]').setInputFiles(BGL_LOG);
  await page.locator('.ls-imp-filerow').first().waitFor({ state: 'visible', timeout: 20000 });
  ok('BGL log file added to the file list');

  // ── Step 3: Wait for pattern detection ──────────────────────────────────
  await page.waitForFunction(
    () => !/Detecting|detecting|Reading the first lines/.test(document.body.innerText),
    { timeout: 30000 }
  );
  ok('Pattern detection complete');

  // ── Step 4: Verify detection input and result ───────────────────────────
  await assert(detectionLines === Math.min(PREVIEW_LINES, BGL_LINES),
    `Detection ran on the first ${Math.min(PREVIEW_LINES, BGL_LINES)} lines (got ${detectionLines})`);

  const fileRow = await page.locator('.ls-imp-filerow').first().innerText();
  const previewHead = await page.locator('.ls-imp-pane-head').filter({ hasText: 'Preview' }).first().innerText();
  await assert(/BGL Supercomputer/.test(fileRow) && /BGL Supercomputer/.test(previewHead),
    'BGL Supercomputer pattern detected');
  await assert(/100% match/.test(previewHead), 'Detected pattern matches 100% of preview lines');
  if (!/BGL Supercomputer/.test(previewHead)) console.log('  Preview header:', previewHead.replace(/\s+/g, ' '));

  // ── Step 5: Verify the preview pane ──────────────────────────────────────
  const rows = await page.locator('.ls-imp-prow').count();
  await assert(rows === Math.min(PREVIEW_LINES, BGL_LINES), `Preview shows ${rows} rows`);
  const failedRows = await page.locator('.ls-imp-gutter--err').count();
  await assert(failedRows === 0, `No preview row failed to parse (got ${failedRows})`);

  // ── Step 6: Import ───────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^Import 1 file$/ }).click();
  ok('Clicked "Import 1 file"');

  await page.getByText('Import complete', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  const summary = await page.getByText(/1 file · [\d,]+ lines/).first().innerText();
  await assert(summary.includes(`${BGL_LINES.toLocaleString('en-US')} lines`), `Import summary: "${summary}"`);

  // ── Step 7: Verify data in backend ──────────────────────────────────────
  await page.waitForTimeout(1000);
  const all = await fetch(`${API_URL}/logs?limit=1&${ALL_TIME}`).then(r => r.json()).catch(() => null);
  const storedCount = all?.total_count ?? 0;
  await assert(storedCount === BGL_LINES, `All ${BGL_LINES} BGL lines stored (got ${storedCount})`);

  const ras = await fetch(`${API_URL}/logs?limit=5&query=RAS&${ALL_TIME}`).then(r => r.json()).catch(() => null);
  await assert((ras?.total_count ?? 0) > 0, `Search for RAS finds BGL logs (got ${ras?.total_count ?? 0})`);

  const consoleErrors = consoleMsgs.filter(m =>
    m.startsWith('[error]') && !m.includes('favicon') && !m.includes('ollama') && !m.includes('404'));
  await assert(consoleErrors.length === 0, 'No browser console errors');

} catch (err) {
  fail('Unexpected error', err);
} finally {
  // Print network diagnostics
  if (ingestLog.length > 0) {
    console.log('\n\x1b[1m[Ingest API calls]\x1b[0m');
    for (const entry of ingestLog) {
      const status = entry.status === 200 ? '\x1b[32m200\x1b[0m' : `\x1b[31m${entry.status}\x1b[0m`;
      console.log(`  ${status} ${entry.url.split('/api/v1')[1]}`);
      if (entry.body && entry.body.status && entry.body.status !== 'success') {
        console.log('       body:', JSON.stringify(entry.body));
      }
    }
  }

  if (networkErrors.length > 0) {
    console.log('\n\x1b[1m[Network errors]\x1b[0m');
    networkErrors.forEach(e => console.log(' ', e));
  }

  if (consoleMsgs.filter(m => m.includes('[error]')).length > 0) {
    console.log('\n\x1b[1m[Browser console errors]\x1b[0m');
    consoleMsgs.filter(m => m.includes('[error]')).forEach(m => console.log(' ', m));
  }

  await browser.close();

  console.log(`\n\x1b[1mResult: ${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed > 0 ? 1 : 0);
}
