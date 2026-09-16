/**
 * Folder watch E2E (spec now-04): add a watch through Settings → Watched
 * folders, copy sample-logs/apache.log into the watched directory, and
 * check that the file is followed, its rows are searchable under a
 * watch.* source, and the status bar says so; then stop the watch through
 * its confirm and check the rows stay.
 *
 *   node e2e-watch.mjs                                     # embedded build on :8080
 *   E2E_BASE_URL=http://localhost:8081 node e2e-watch.mjs   # dev split
 *
 * The server's reconciliation sweep is 60 s by default; run-e2e.sh starts
 * the binary with LOGSONIC_WATCH_SWEEP=2s so a missed fsnotify event
 * doesn't stall this script.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const API_URL = process.env.E2E_API_URL || 'http://localhost:8080/api/v1';
const headless = !process.argv.includes('--headed');

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, detail) => { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`); failed++; };
const assert = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));
const api = async (path) => (await fetch(`${API_URL}${path}`)).json();
const total = async (src) => (await api(`/logs?limit=1&_src=${encodeURIComponent(src)}&start_date=2000-01-01T00:00:00Z&end_date=2100-01-01T00:00:00Z`)).total_count;

const dir = mkdtempSync(join(tmpdir(), 'logsonic-e2e-watch-'));
const dirName = dir.split('/').pop();
const source = `watch.${dirName}.apache.log`;
const sample = resolve(process.cwd(), '..', 'sample-logs', 'apache.log');

const browser = await chromium.launch({ headless });
const page = await browser.newContext().then((c) => c.newPage());
try {
  await page.goto(`${BASE_URL}/#/settings/watches`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByLabel('Folder to watch').waitFor({ timeout: 15000 });
  ok('Watched folders page loaded');
  await page.getByLabel('Folder to watch').fill(dir);
  assert((await page.locator('[data-testid="watch-form"]').textContent()).includes(`watch.${dirName}.`), 'form previews the source name');
  await page.getByRole('button', { name: 'Watch folder' }).click();
  const card = page.locator('[data-testid="watch-card"]', { hasText: dir });
  await card.waitFor({ timeout: 10000 });
  ok('watch card appears with the folder path');
  assert((await card.textContent()).includes('No matching files yet'), 'an empty folder shows no files yet');

  copyFileSync(sample, join(dir, 'apache.log'));
  await card.locator('[data-testid="watch-file"]', { hasText: 'apache.log' }).waitFor({ timeout: 20000 });
  ok('the dropped file appears in the watch');
  await card.locator('[data-testid="watch-file"]', { hasText: 'following' }).waitFor({ timeout: 30000 });
  ok('the file reaches "following" (auto-detected pattern)');
  const deadline = Date.now() + 30000;
  let rows = 0;
  while (Date.now() < deadline && rows < 2000) {
    rows = await total(source);
    if (rows < 2000) await new Promise((r) => setTimeout(r, 250));
  }
  assert(rows === 2000, `rows searchable under ${source}`, `got ${rows}`);
  const entry = await api(`/sources/${encodeURIComponent(source)}`);
  assert(entry.origin?.kind === 'watch', 'catalog origin is "watch"', JSON.stringify(entry.origin));

  // The status bar lives on Home; the indicator fetches the watch list on mount.
  await page.goto(`${BASE_URL}/#/?isRelative=true&relativeValue=last-10-years`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const indicator = page.locator('[data-testid="watch-indicator"]');
  await indicator.waitFor({ timeout: 15000 });
  assert(/Watching \d+ folders?/.test(await indicator.textContent()), 'status bar on Home shows the watch indicator');
  await indicator.click();
  await page.getByLabel('Folder to watch').waitFor({ timeout: 15000 });
  ok('the indicator links back to Watched folders');
  await card.waitFor({ timeout: 10000 });

  await card.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.textContent();
  assert(/Stop watching/.test(text) && /Rows already indexed stay/.test(text), 'confirm says what stops and what stays', text);
  await dialog.getByRole('button', { name: 'Stop watching' }).click();
  await card.waitFor({ state: 'detached', timeout: 10000 });
  ok('watch card disappears after confirming');
  assert((await total(source)) === 2000, 'rows stay after the watch is deleted');
  assert((await api('/watches')).watches.every((w) => w.dir !== dir), 'server no longer lists the watch');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall watch checks passed');
process.exit(failed ? 1 : 0);
