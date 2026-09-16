/**
 * Sources panel + Storage settings E2E (spec now-10 C9 and the storage
 * page): seed two sources, open the Sources panel from the rail, check both
 * rows, delete one through its confirm, and check that the row, the status
 * bar's source count and the Fields panel's _src facet all update without a
 * reload. Then, on Settings → Storage: retention shows its source, saving
 * and clearing it round-trips, and deleting a day (an old one seeded here
 * with explicit timestamps, so today's shard and the other scripts' data
 * are untouched) drops it from the table and the status bar.
 *
 *   node e2e-sources.mjs                                    # embedded build on :8080
 *   E2E_BASE_URL=http://localhost:8081 node e2e-sources.mjs  # dev split
 *
 * Seeds its own rows (sources e2e-src-a.log / e2e-src-b.log) and deletes B;
 * A stays. A re-run re-seeds both, so it is deterministic either way.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const API_URL = process.env.E2E_API_URL || 'http://localhost:8080/api/v1';
const headless = !process.argv.includes('--headed');

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, detail) => { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`); failed++; };
const assert = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));

async function api(method, path, body) {
  const r = await fetch(`${API_URL}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const post = (path, body) => api('POST', path, body);

// --- seed: two sources, stored _src = file.<name> as the wizard does ------
const A = 'file.e2e-src-a.log';
const B = 'file.e2e-src-b.log';
for (const [src, count] of [[A, 30], [B, 12]]) {
  const start = await post('/ingest/start', {
    name: 'E2E_SOURCES', pattern: '%{WORD:level} %{GREEDYDATA:message}', source: src.replace(/^file\./, ''), meta: { _src: src },
  });
  await post('/ingest/logs', { logs: Array.from({ length: count }, (_, i) => `INFO sources e2e row ${i}`), session_id: start.session_id });
  await post('/ingest/end', { session_id: start.session_id });
}
const catalog = await api('GET', '/sources');
const names = catalog.sources.map((s) => s.name);
assert(names.includes(A) && names.includes(B), 'seeded two sources into the catalog', names.join(','));
const sourceCountBefore = names.length;

// --- browser -----------------------------------------------------------
const browser = await chromium.launch({ headless });
const page = await browser.newContext().then((c) => c.newPage());
const statusCount = async () => {
  const text = await page.locator('text=/sources? indexed|No sources indexed/').first().textContent({ timeout: 5000 }).catch(() => null);
  if (!text) return null;
  if (/No sources/.test(text)) return 0;
  const m = text.match(/(\d+) source/);
  return m ? Number(m[1]) : null;
};

await page.goto(`${BASE_URL}/#/?isRelative=true&relativeValue=last-10-years`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first().waitFor({ timeout: 15000 });
ok('app loaded');
await page.waitForFunction((n) => /(\d+) source/.test(document.body.innerText) && Number(document.body.innerText.match(/(\d+) sources? indexed/)?.[1]) >= n, sourceCountBefore, { timeout: 10000 }).catch(() => {});
assert((await statusCount()) === sourceCountBefore, `status bar shows ${sourceCountBefore} sources indexed`, String(await statusCount()));

await page.locator('button[aria-label="Sources"]').click({ timeout: 10000 });
await page.locator('[data-testid="source-row"]').first().waitFor({ timeout: 10000 });
ok('Sources panel opened from the rail');
const rowNames = await page.locator('[data-testid="source-row"] button[aria-expanded] span[title]').allTextContents();
assert(rowNames.includes(A) && rowNames.includes(B), 'panel lists both seeded sources', rowNames.join(','));

// --- delete B through the confirm ---------------------------------------
await page.locator('[data-testid="source-row"]', { hasText: B }).locator('button[aria-expanded]').click();
await page.locator('[data-testid="source-row"]', { hasText: B }).getByRole('button', { name: 'Delete' }).click();
const dialog = page.getByRole('alertdialog');
await dialog.waitFor({ timeout: 5000 });
const dialogText = await dialog.textContent();
assert(/Delete file\.e2e-src-b\.log\?/.test(dialogText) && /12 rows/.test(dialogText) && /can't be undone/.test(dialogText), 'confirm names the source, its 12 rows, and that it cannot be undone', dialogText);
await dialog.getByRole('button', { name: 'Delete source' }).click();
await page.locator('[data-testid="source-row"]', { hasText: B }).waitFor({ state: 'detached', timeout: 10000 });
ok('row disappears after confirming');

const after = await api('GET', '/sources');
assert(!after.sources.some((s) => s.name === B) && after.sources.some((s) => s.name === A), 'server catalog dropped B and kept A');
await page.waitForFunction((n) => new RegExp(`${n} sources? indexed`).test(document.body.innerText), sourceCountBefore - 1, { timeout: 10000 }).catch(() => {});
assert((await statusCount()) === sourceCountBefore - 1, 'status bar source count drops by one without a reload', String(await statusCount()));

// --- the _src facet reflects the delete without a reload -----------------
await page.locator('button[aria-label="Fields"]').click({ timeout: 10000 });
const srcRow = page.locator('button[aria-expanded]', { hasText: '_src' }).first();
await srcRow.waitFor({ timeout: 15000 });
if ((await srcRow.getAttribute('aria-expanded')) !== 'true') await srcRow.click();
await page.waitForFunction(() => !document.body.innerText.includes('file.e2e-src-b.log'), null, { timeout: 10000 }).catch(() => {});
const facetText = await page.locator('body').innerText();
assert(facetText.includes(A) && !facetText.includes(B), '_src facet lists A and no longer lists B', '');

// --- Storage settings page -------------------------------------------------
// Seed one old day under its own source so deleting it touches nothing else.
const OLD_DAY = '2019-06-15';
const OLD_SRC = 'file.e2e-old-day.log';
{
  const start = await post('/ingest/start', {
    name: 'E2E_OLD', pattern: '%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{GREEDYDATA:message}', source: 'e2e-old-day.log', meta: { _src: OLD_SRC },
  });
  await post('/ingest/logs', { logs: Array.from({ length: 9 }, (_, i) => `${OLD_DAY}T10:00:0${i}Z INFO old row ${i}`), session_id: start.session_id });
  await post('/ingest/end', { session_id: start.session_id });
}
const storageBefore = await api('GET', '/storage');
assert(storageBefore.days.some((d) => d.date === OLD_DAY), 'seeded a day-index for 2019-06-15', storageBefore.days.map((d) => d.date).join(','));

await page.goto(`${BASE_URL}/#/settings/storage`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.locator('[data-testid="storage-day"]').first().waitFor({ timeout: 15000 });
ok('Storage settings page loaded with the day table');
const retentionInput = page.getByLabel('Retention days');
assert((await retentionInput.inputValue()) === String(storageBefore.retention_days), `retention input shows the value in effect (${storageBefore.retention_days})`);
assert(await page.locator('[data-testid="storage-retention"]').textContent().then((t) => /Nothing set|From the -retention-days|Set here/.test(t)), 'retention row names its source');

// Save 3650, see it come back as "Set here", then clear. The save prunes
// synchronously, and the smoke suite's Apache sample is from 2005, so the
// store can legitimately lose days here -- the delete-day check below
// takes its baseline after this, not before.
await retentionInput.fill('3650');
await page.getByRole('button', { name: 'Save' }).click();
await page.locator('[data-testid="storage-retention"]', { hasText: 'Set here' }).waitFor({ timeout: 10000 });
ok('saving retention shows it as set here (config.json)');
const afterSave = await api('GET', '/storage');
assert(afterSave.retention_days === 3650 && afterSave.retention_source === 'config', 'server has the override', `${afterSave.retention_days}/${afterSave.retention_source}`);
await page.getByRole('button', { name: /Clear/ }).click();
await page.waitForFunction(() => !document.body.innerText.includes('Set here'), null, { timeout: 10000 }).catch(() => {});
const afterClear = await api('GET', '/storage');
assert(afterClear.retention_source !== 'config', 'clearing removes the override', afterClear.retention_source);

// Delete the seeded old day through its confirm.
const sourcesBeforeDay = (await api('GET', '/sources')).sources.length;
await page.getByRole('button', { name: `Delete ${OLD_DAY}` }).click();
const dayDialog = page.getByRole('alertdialog');
await dayDialog.waitFor({ timeout: 5000 });
const dayText = await dayDialog.textContent();
assert(new RegExp(`Delete ${OLD_DAY}\\?`).test(dayText) && /9 rows/.test(dayText) && /can't be undone/.test(dayText), 'delete-day confirm names the day, its 9 rows, and that it cannot be undone', dayText);
await dayDialog.getByRole('button', { name: 'Delete day' }).click();
await page.locator('[data-testid="storage-day"]', { hasText: OLD_DAY }).waitFor({ state: 'detached', timeout: 10000 });
ok('the day leaves the table after confirming');
const storageAfter = await api('GET', '/storage');
assert(!storageAfter.days.some((d) => d.date === OLD_DAY), 'server no longer has the day-index');
const sourcesAfterDay = (await api('GET', '/sources')).sources.length;
assert(sourcesAfterDay === sourcesBeforeDay - 1, 'the source whose only day it was is gone from the catalog', `${sourcesBeforeDay} -> ${sourcesAfterDay}`);
await page.goto(`${BASE_URL}/#/?isRelative=true&relativeValue=last-10-years`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForFunction((n) => new RegExp(`${n} sources? indexed`).test(document.body.innerText), sourcesAfterDay, { timeout: 10000 }).catch(() => {});
assert((await statusCount()) === sourcesAfterDay, 'status bar reflects the deleted day\'s source', String(await statusCount()));

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall sources checks passed');
process.exit(failed ? 1 : 0);
