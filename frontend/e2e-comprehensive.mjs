/**
 * Current full browser journey for the embedded LogSonic build.
 *
 * Run against an isolated backend, for example:
 *   BASE_URL=http://127.0.0.1:8080 API_URL=http://127.0.0.1:8080/api/v1 node e2e-comprehensive.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.BASE_URL || 'http://localhost:8081';
const apiURL = process.env.API_URL || 'http://localhost:8080/api/v1';
const sampleLog = path.resolve(root, '../sample-logs/postgresql.log');
const headless = !process.argv.includes('--headed');

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed += 1;
}

function fail(label, error) {
  console.error(`  ✗ ${label}: ${error?.message ?? error}`);
  failed += 1;
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (error) {
    fail(label, error);
  }
}

async function clearLogs() {
  const response = await fetch(`${apiURL}/logs`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`clear logs returned ${response.status}`);
}

async function main() {
  console.log('=== LogSonic Full E2E Journey ===');
  console.log(`  Frontend: ${baseURL}`);
  console.log(`  Backend:  ${apiURL}`);
  await clearLogs();

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await check('home page loads with the expected title', async () => {
      await page.goto(`${baseURL}/#/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (await page.title() !== 'LogSonic') throw new Error(`title was ${await page.title()}`);
    });

    await check('empty state exposes search and import controls', async () => {
      const search = page.locator('input[placeholder*="Search logs" i]');
      await search.first().waitFor({ state: 'visible', timeout: 10000 });
      if (!await page.getByText('Import logs', { exact: true }).count()) throw new Error('Import logs control missing');
      await page.getByRole('button', { name: /Import logs/i }).first().click();
      await page.waitForURL(/#\/import$/, { timeout: 5000 });
    });

    await check('local import analyzes and ingests one file', async () => {
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
      await page.locator('input[type="file"]').setInputFiles(sampleLog);
      await page.getByText('Pattern configuration', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForFunction(() => {
        const body = document.body.innerText;
        return !body.includes('Detecting...') && !body.includes('Queued');
      }, { timeout: 30000 });
      await page.getByRole('button', { name: /^Import 1 File$/ }).click();
      await page.getByRole('heading', { name: 'Import successful', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      if (!await page.getByText('Lines processed', { exact: true }).count()) throw new Error('import summary missing');
    });

    await check('import redirects back to the home view', async () => {
      await page.waitForURL(/#\/$/, { timeout: 10000 });
      if (!await page.locator('input[placeholder*="Search logs" i]').count()) throw new Error('home search missing after redirect');
    });

    await check('workspace can be saved and deleted with confirmation', async () => {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click();
      await page.getByPlaceholder('Workspace name').fill('E2E workspace');
      await page.getByRole('button', { name: 'Save as', exact: true }).click();
      await page.getByText('E2E workspace', { exact: true }).last().waitFor({ state: 'visible', timeout: 10000 });

      page.once('dialog', (dialog) => dialog.accept());
      await page.getByTitle('Delete').last().click();
      await page.getByText('No saved workspaces', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    });

    await check('clear-log confirmation removes indexed data', async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Clear logs' }).click();
      await page.getByPlaceholder('delete').fill('delete');
      await page.getByRole('button', { name: 'Delete All', exact: true }).click();
      await page.waitForTimeout(500);
      const response = await fetch(`${apiURL}/logs`);
      if (!response.ok) throw new Error(`logs returned ${response.status}`);
      const body = await response.json();
      if ((body.total_count ?? body.count ?? 0) !== 0) throw new Error('logs remain after deletion');
    });

    await check('no critical browser console errors occurred', async () => {
      const critical = consoleErrors.filter((message) =>
        !message.includes('favicon') && !message.includes('ollama') && !message.includes('404')
      );
      if (critical.length) throw new Error(critical.slice(0, 3).join('; '));
    });
  } finally {
    await page.screenshot({ path: '/tmp/logsonic-e2e-full.png', fullPage: true }).catch(() => {});
    await browser.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
