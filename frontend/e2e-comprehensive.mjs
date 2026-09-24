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
      // Single-surface import: the file lands in the split pane and detection
      // starts at once; the topbar's "Import 1 file" commits it.
      await page.locator('.ls-imp-filerow').first().waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForFunction(() => !document.body.innerText.includes('Detecting'), { timeout: 30000 });
      await page.getByRole('button', { name: /^Import 1 file$/ }).click();
      await page.getByText('Import complete', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      if (!await page.getByText(/1 file · [\d,]+ lines/).count()) throw new Error('import summary missing');
    });

    await check('import redirects back to the home view', async () => {
      await page.waitForURL(/#\/$/, { timeout: 10000 });
      if (!await page.locator('input[placeholder*="Search logs" i]').count()) throw new Error('home search missing after redirect');
    });

    await check('history recall (↑↑) then star + save + reload restores a saved query', async () => {
      // Runs on its own page/tab: repeatedly opening and closing the
      // saved-query star popover, the workspace popover (three times), and
      // reloading mid-check left the shared `page`'s Radix popovers in a
      // state where the *next* check's clicks on the same components
      // intermittently hit a detached element -- isolating this scenario
      // avoids leaving that residue behind for later checks to inherit.
      const historyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await historyPage.goto(`${baseURL}/#/`, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // A placeholder-based locator breaks here: focusing the input
        // changes its placeholder text (away from "Search logs…"), which
        // this check's repeated fill/press cycle would otherwise re-trigger
        // every step.
        const search = historyPage.getByRole('textbox', { name: 'Search logs' });

        await search.fill('level:error');
        await search.press('Enter');
        await historyPage.waitForTimeout(300);

        await search.fill('level:info');
        await search.press('Enter');
        await historyPage.waitForTimeout(300);

        await search.fill('');
        await search.press('ArrowUp');
        await search.press('ArrowUp');
        const recalled = await search.inputValue();
        if (recalled !== 'level:error') {
          throw new Error(`expected "level:error" after two ArrowUp presses, got "${recalled}"`);
        }

        await historyPage.getByRole('button', { name: 'Save this query', exact: true }).click();
        await historyPage.getByPlaceholder('Name').fill('errors');
        await historyPage.getByRole('button', { name: 'Save', exact: true }).click();

        await historyPage.getByRole('button', { name: 'Workspace menu', exact: true }).click();
        await historyPage.getByPlaceholder('Workspace name').fill('E2E saved-query workspace');
        await historyPage.getByRole('button', { name: 'Save as', exact: true }).click();
        await historyPage
          .getByText('E2E saved-query workspace', { exact: true })
          .last()
          .waitFor({ state: 'visible', timeout: 10000 });
        await historyPage.keyboard.press('Escape');

        // Reload to prove the saved query round-tripped through disk, not
        // just in-memory Zustand state.
        await historyPage.reload({ waitUntil: 'domcontentloaded' });
        await historyPage.getByRole('textbox', { name: 'Search logs' }).waitFor({ state: 'visible', timeout: 10000 });

        await historyPage.getByRole('button', { name: 'Workspace menu', exact: true }).click();
        await historyPage.getByText('E2E saved-query workspace', { exact: true }).last().click();
        await historyPage.keyboard.press('Escape');

        await historyPage.getByRole('button', { name: 'Saved queries & history', exact: true }).click();
        await historyPage.getByText('errors', { exact: true }).click();

        await historyPage.waitForFunction(() => {
          const input = document.querySelector('input[aria-label="Search logs"]');
          return input instanceof HTMLInputElement && input.value === 'level:error';
        }, { timeout: 10000 });

        // Clean up this check's own workspace so the next check (which
        // expects a clean slate) is unaffected.
        await historyPage.getByRole('button', { name: 'Workspace menu', exact: true }).click();
        historyPage.once('dialog', (dialog) => dialog.accept());
        await historyPage.getByTitle('Delete').last().click();
        await historyPage.getByText('No saved workspaces', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
      } finally {
        await historyPage.close();
      }
    });

    await check('workspace can be saved and deleted with confirmation', async () => {
      await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
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
