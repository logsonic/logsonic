/**
 * BGL Supercomputer log import E2E test.
 * Run: node e2e-bgl-import.mjs [--headed]
 * Requires: backend on :8080, frontend on :8081
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_LOGS_DIR = path.resolve(__dirname, '../sample-logs');
const BGL_LOG = path.join(SAMPLE_LOGS_DIR, 'bgl-supercomputer.log');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8081';
const API_URL  = process.env.API_URL  || 'http://localhost:8080/api/v1';
const headless = !process.argv.includes('--headed');

let passed = 0, failed = 0;

function ok(label)       { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
function fail(label, err){ console.error(`  \x1b[31m✗\x1b[0m ${label}: ${err?.message ?? err}`); failed++; }

async function assert(cond, label) { if (cond) ok(label); else fail(label, new Error('assertion failed')); }

async function clearLogs() {
  try { await fetch(`${API_URL}/logs`, { method: 'DELETE' }); } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 100 });
const context = await browser.newContext();
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

// Capture full network log for ingest endpoints
const ingestLog = [];
page.on('response', async r => {
  if (r.url().includes('/ingest')) {
    try {
      const body = await r.json().catch(() => null);
      ingestLog.push({ url: r.url(), status: r.status(), body });
    } catch {}
  }
});

try {
  await clearLogs();

  console.log('\n\x1b[1m[BGL Import E2E]\x1b[0m');

  // ── Step 1: Navigate to Import ──────────────────────────────────────────
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const importBtn = page.getByRole('link', { name: /import/i })
    .or(page.getByText(/import logs?/i))
    .or(page.locator('a[href*="import"]'))
    .first();
  await importBtn.click();
  await page.waitForURL('**/import**', { timeout: 5000 }).catch(() => {});
  ok('Navigated to Import page');

  // ── Step 2: Click "Upload Log File" source button ────────────────────────
  await page.getByText('Upload Log File').click();
  await page.waitForTimeout(500);
  ok('Selected "Upload Log File" source');

  // ── Step 3: Upload BGL log file (hidden input — set directly) ─────────────
  await page.locator('input[type="file"]').setInputFiles(BGL_LOG);
  await page.waitForTimeout(500);
  ok('BGL log file selected');

  // ── Step 3: Wait for pattern detection ──────────────────────────────────
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return !text.includes('Detecting...') && !text.includes('Queued') && !text.includes('detecting');
    },
    { timeout: 30000 }
  );
  await page.waitForTimeout(1000);
  ok('Pattern detection complete');

  // ── Step 4: Verify BGL pattern was detected ──────────────────────────────
  const bodyText = await page.evaluate(() => document.body.innerText);
  const bglDetected = bodyText.includes('IBM BGL') || bodyText.includes('BGL Supercomputer');
  await assert(bglDetected, 'IBM BGL Supercomputer pattern detected');

  if (!bglDetected) {
    console.log('  Body text snippet:', bodyText.slice(0, 500));
  }

  // ── Step 5: Verify "Pattern found" badge (not "Unknown Format") ──────────
  const notUnknown = !bodyText.includes('Unknown Format 1');
  await assert(notUnknown, 'No "Unknown Format" fallback shown');

  // ── Step 6: Click Next → Define Log Pattern step ─────────────────────────
  const nextBtn = page.getByRole('button', { name: /next/i }).first();
  await nextBtn.click();
  await page.waitForTimeout(1000);
  ok('Advanced to step 2 (Define Log Pattern)');

  // ── Step 7: Click Next → Confirm Import step ─────────────────────────────
  const nextBtn2 = page.getByRole('button', { name: /next/i }).first();
  await nextBtn2.click();
  await page.waitForTimeout(1000);
  ok('Advanced to step 3 (Confirm Import)');

  // ── Step 8: Click Import ─────────────────────────────────────────────────
  const importSubmitBtn = page.getByRole('button', { name: /^import$/i })
    .or(page.getByRole('button', { name: /start import/i }))
    .or(page.getByRole('button', { name: /confirm/i }))
    .first();
  await importSubmitBtn.click();
  ok('Clicked Import button');

  // ── Step 9: Wait for import to complete ─────────────────────────────────
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes('success') || text.includes('Success') ||
             text.includes('failed') || text.includes('Failed') ||
             text.includes('imported') || text.includes('complete') ||
             text.includes('error') || text.includes('Error');
    },
    { timeout: 60000 }
  ).catch(e => console.log('  [timeout waiting for result]', e.message));

  await page.waitForTimeout(2000);
  ok('Import completed (or timed out)');

  // ── Step 10: Check result ─────────────────────────────────────────────────
  const resultText = await page.evaluate(() => document.body.innerText);
  const importFailed = resultText.includes('failed') || resultText.includes('Failed') ||
                       resultText.includes('error') && !resultText.includes('0 error');
  const importSuccess = resultText.includes('success') || resultText.includes('Success') ||
                        resultText.includes('imported') || resultText.includes('complete');

  await assert(importSuccess && !importFailed, 'Import completed successfully');

  if (!importSuccess || importFailed) {
    console.log('\n  Result text snippet:');
    console.log('  ', resultText.slice(0, 800));
  }

  // ── Step 11: Verify data in backend ──────────────────────────────────────
  await page.waitForTimeout(1000);
  const logsResp = await fetch(`${API_URL}/logs?limit=5&query=RAS`).then(r => r.json()).catch(() => null);
  const storedCount = logsResp?.total_count ?? 0;
  await assert(storedCount > 0, `BGL logs stored in backend (got ${storedCount})`);

} catch (err) {
  fail('Unexpected error', err);
} finally {
  // Print network diagnostics
  if (ingestLog.length > 0) {
    console.log('\n\x1b[1m[Ingest API calls]\x1b[0m');
    for (const entry of ingestLog) {
      const status = entry.status === 200 ? '\x1b[32m200\x1b[0m' : `\x1b[31m${entry.status}\x1b[0m`;
      console.log(`  ${status} ${entry.url.split('/api/v1')[1]}`);
      if (entry.body && entry.body.status !== 'success') {
        console.log('       body:', JSON.stringify(entry.body));
      } else if (entry.body) {
        console.log(`       processed=${entry.body.processed ?? '?'} failed=${entry.body.failed ?? '?'}`);
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
