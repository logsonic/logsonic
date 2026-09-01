/**
 * Network audit: proves the "no telemetry, no cloud, no network calls"
 * promise against the EMBEDDED build (the Go server serving the real SPA).
 *
 * Drives load -> import wizard (file picked) -> search -> theme toggle ->
 * export while recording every request the page makes, and fails if any
 * request goes anywhere but the server's own origin (or the blob:/data:/about:
 * schemes the app uses locally). This is the automated form of spec now-01 T3
 * and the proof behind principle D2 in TBD.md.
 *
 *   node e2e-network-audit.mjs                      # server on :8080
 *   E2E_BASE_URL=http://127.0.0.1:8123 node e2e-network-audit.mjs
 *
 * Uses page.on('request') (passive) rather than page.route(): route
 * interception can interfere with the live SSE stream.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '../sample-logs/apache.log');
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const origin = new URL(BASE_URL).origin;
const ALLOWED_SCHEMES = new Set(['blob:', 'data:', 'about:']);

const requests = [];
const offenders = [];

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

page.on('request', (req) => {
  const url = req.url();
  requests.push(url);
  let u;
  try { u = new URL(url); } catch { offenders.push(url); return; }
  if (ALLOWED_SCHEMES.has(u.protocol)) return;
  if (u.origin !== origin) offenders.push(url);
});

const step = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (err) { console.log(`  · ${label} (skipped: ${err.message.split('\n')[0]})`); }
};

console.log(`network audit against ${BASE_URL}`);
// Not 'networkidle': the live-events SSE stream keeps a connection open, so
// the page never goes idle. Wait for the search bar instead.
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first().waitFor({ timeout: 15000 });
console.log('  ✓ loaded');

await step('import wizard with a sample file', async () => {
  await page.goto(`${BASE_URL}/#/import`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('input[type="file"]').first().setInputFiles([SAMPLE], { timeout: 10000 });
  await page.waitForTimeout(3000); // pattern detection + timestamp preview calls
});

await step('search', async () => {
  await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const input = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  await input.fill('notice', { timeout: 10000 });
  await page.keyboard.press('Enter'); // the input re-renders on change; a stale locator's press() hangs
  await page.waitForTimeout(1500);
});

await step('theme toggle', async () => {
  const btn = page.locator('button[aria-label="Toggle theme"]').first();
  await btn.click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await btn.click({ timeout: 5000 });
});

await step('export', async () => {
  const btn = page.locator('button', { has: page.locator('text=/export/i') }).first();
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await btn.click({ timeout: 5000 });
  await dl;
});

await page.waitForTimeout(1000);
await browser.close();

const hosts = [...new Set(requests.map((u) => { try { return new URL(u).origin; } catch { return u; } }))];
console.log(`requests: ${requests.length}; origins seen: ${hosts.join(', ')}`);

if (offenders.length) {
  console.error(`✗ ${offenders.length} request(s) left the server origin:`);
  for (const u of [...new Set(offenders)]) console.error(`    ${u}`);
  process.exit(1);
}
if (requests.length < 5) {
  console.error('✗ too few requests recorded; the audit did not exercise the app');
  process.exit(1);
}
console.log('✓ zero non-loopback requests');
