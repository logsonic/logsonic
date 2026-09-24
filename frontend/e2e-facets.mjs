/**
 * Fields panel E2E (spec now-02): with rows that have level/service fields
 * seeded, open the Fields panel, check the facet rows render with counts,
 * click a value (query gains +field:"value" and the hit count drops), alt-click
 * another value (query gains -field:"value"), click the first value again
 * (its clause is removed).
 *
 *   node e2e-facets.mjs                                   # embedded build on :8080
 *   E2E_BASE_URL=http://localhost:8081 node e2e-facets.mjs # dev split (vite :8081 -> backend :8080)
 *
 * Seeds its own rows through the ingest API (source e2e-facets.log) so it
 * does not depend on prior state; it does not clear other data. Scoping the
 * query to that source with +_src:"…" is a test convenience for deterministic
 * counts, not the contract under test -- keep it even after now-10 changes
 * how the _src facet itself is computed.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const API_URL = process.env.E2E_API_URL || 'http://localhost:8080/api/v1';
const headless = !process.argv.includes('--headed');

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, detail) => { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`); failed++; };
const assert = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));

async function post(path, body) {
  const r = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// --- seed ---------------------------------------------------------------
const start = await post('/ingest/start', {
  name: 'E2E_FACETS', pattern: '%{WORD:level} %{WORD:service} %{GREEDYDATA:message}', source: 'e2e-facets.log', meta: { _src: 'file.e2e-facets.log' },
});
const lines = [];
for (let i = 0; i < 60; i += 1) {
  const level = i % 4 === 0 ? 'ERROR' : 'INFO';          // 15 ERROR, 45 INFO
  const service = i % 3 === 0 ? 'auth' : 'api';          // 20 auth, 40 api
  lines.push(`${level} ${service} facet e2e row ${i}`);
}
await post('/ingest/logs', { logs: lines, session_id: start.session_id });
await post('/ingest/end', { session_id: start.session_id });
ok('seeded 60 rows (15 ERROR / 45 INFO, 20 auth / 40 api)');

// --- browser ------------------------------------------------------------
const browser = await chromium.launch({ headless });
const page = await browser.newContext().then((c) => c.newPage());
const hits = async () => {
  const text = await page.locator('text=/^Hits/').first().textContent({ timeout: 5000 }).catch(() => null);
  const m = text?.match(/Hits\s*([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
const queryValue = () => page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first().inputValue();

await page.goto(`${BASE_URL}/#/?isRelative=true&relativeValue=last-10-years`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first().waitFor({ timeout: 15000 });
ok('app loaded');

// Restrict to the seeded source so counts are deterministic regardless of other data.
await page.locator('button[aria-label="Fields"]').click({ timeout: 10000 });
const panelHeader = page.locator('text=Fields').first();
await panelHeader.waitFor({ timeout: 10000 });
ok('Fields panel opened from the rail');

// Filter to our source via the query bar (the facet itself is what we're testing).
const input = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
await input.fill('+_src:"file.e2e-facets.log"');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const baseHits = await hits();
assert(baseHits === 60, 'search scoped to the seeded source shows 60 hits', `got ${baseHits}`);

// The level field row: expand it and read its values.
const levelRow = page.locator('button[aria-expanded]', { hasText: 'level' }).first();
await levelRow.waitFor({ timeout: 15000 });
await levelRow.click();
const errorValue = page.locator('button', { hasText: /^ERROR/ }).first();
await errorValue.waitFor({ timeout: 10000 });
const errorText = await errorValue.textContent();
assert(/15/.test(errorText || ''), 'level facet lists ERROR with count 15', errorText || '');

// Click ERROR -> +level:"ERROR", 15 hits.
await errorValue.click();
await page.waitForTimeout(1500);
assert((await queryValue()).includes('+level:"ERROR"'), 'clicking a value adds +level:"ERROR" to the query', await queryValue());
assert((await hits()) === 15, 'hit count drops to 15', `got ${await hits()}`);

// Alt-click auth in the service field -> -service:"auth".
const serviceRow = page.locator('button[aria-expanded]', { hasText: 'service' }).first();
await serviceRow.click();
const authValue = page.locator('button', { hasText: /^auth/ }).first();
await authValue.waitFor({ timeout: 10000 });
await authValue.click({ modifiers: ['Alt'] });
await page.waitForTimeout(1500);
assert((await queryValue()).includes('-service:"auth"'), 'alt-clicking a value adds -service:"auth"', await queryValue());
const afterExclude = await hits();
assert(afterExclude !== null && afterExclude < 15, 'excluding auth lowers the hit count further', `got ${afterExclude}`);

// Click ERROR again -> its clause is removed, exclusion stays.
const errorAgain = page.locator('button', { hasText: /^ERROR/ }).first();
await errorAgain.click();
await page.waitForTimeout(1500);
const q = await queryValue();
assert(!q.includes('+level:"ERROR"') && q.includes('-service:"auth"'), 'second click removes the + clause and keeps the exclusion', q);

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall facet checks passed');
process.exit(failed ? 1 : 0);
