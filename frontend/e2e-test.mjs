/**
 * Logsonic E2E tests using Playwright
 * Run with: node e2e-test.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_LOGS_DIR = path.resolve(__dirname, '../sample-logs');

const BASE_URL = 'http://localhost:8080';
const API_URL = 'http://localhost:8080/api/v1';

const headless = !process.argv.includes('--headed');

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  ✗ ${label}: ${err?.message ?? err}`);
  failed++;
}

async function assert(condition, label) {
  if (condition) ok(label);
  else fail(label, new Error('assertion failed'));
}

async function section(title, fn) {
  console.log(`\n[${title}]`);
  try {
    await fn();
  } catch (err) {
    fail(title, err);
  }
}

// ─── API health checks (no browser needed) ──────────────────────────────────
async function apiTests() {
  await section('API Health', async () => {
    const r = await fetch(`${API_URL}/ping`);
    const json = await r.json();
    await assert(r.ok && json.status === 'pong', 'GET /ping returns pong');
  });

  await section('API – Logs', async () => {
    const r = await fetch(`${API_URL}/logs`);
    await assert(r.ok, 'GET /logs returns 200');
    const json = await r.json();
    await assert(Array.isArray(json.logs), 'Response has logs field');
  });

  await section('API – Grok Patterns', async () => {
    const r = await fetch(`${API_URL}/grok`);
    await assert(r.ok, 'GET /grok returns 200');
  });

  await section('API – System Info', async () => {
    const r = await fetch(`${API_URL}/info`);
    await assert(r.ok, 'GET /info returns 200');
    const json = await r.json();
    await assert(json.status === 'success', 'Response has status:success');
  });

  await section('API – AI Status', async () => {
    const r = await fetch(`${API_URL}/ai/status`);
    await assert(r.ok, 'GET /ai/status returns 200');
    const json = await r.json();
    await assert(typeof json.ollama_running === 'boolean', 'ollama_running is boolean');
    await assert(Array.isArray(json.models_available), 'models_available is array');
  });
}

// ─── Browser tests ───────────────────────────────────────────────────────────
async function browserTests(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // ── Home page ──────────────────────────────────────────────────────────
    await section('Home Page – Load', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
      const title = await page.title();
      await assert(title === 'LogSonic', `Page title is "LogSonic" (got "${title}")`);
    });

    await section('Home Page – Core UI Elements', async () => {
      // Header should be present
      await page.waitForSelector('header, [data-testid="header"], nav', { timeout: 5000 }).catch(() => null);

      // Log viewer area or empty state
      const hasContent = await page.locator('main, [role="main"], #root > *').count() > 0;
      await assert(hasContent, 'Main content area renders');

      // Search input
      const searchInput = page.locator('input[placeholder*="search" i], input[placeholder*="query" i], input[type="search"]').first();
      const hasSearch = await searchInput.count() > 0;
      await assert(hasSearch, 'Search input is present');
    });

    await section('Home Page – No Critical JS Errors on Load', async () => {
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('404') && !e.includes('ollama') &&
        !e.includes('Failed to initialize') && !e.includes('ERR_CONNECTION_REFUSED')
      );
      await assert(criticalErrors.length === 0, `No critical JS errors (found ${criticalErrors.length}: ${criticalErrors.slice(0, 2).join('; ')})`);
    });

    // ── Navigation ─────────────────────────────────────────────────────────
    await section('Navigation – To Import Page', async () => {
      // Look for import/upload link
      const importLink = page.locator('a[href*="import"], button:has-text("Import"), a:has-text("Import")').first();
      const hasImportLink = await importLink.count() > 0;
      await assert(hasImportLink, 'Import link/button exists in navigation');

      if (hasImportLink) {
        await importLink.click();
        await page.waitForTimeout(1000);
        const url = page.url();
        await assert(url.includes('import'), `Navigated to import page (url: ${url})`);
      }
    });

    await section('Import Page – Renders', async () => {
      await page.goto(`${BASE_URL}/#/import`, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(500);
      const content = await page.locator('main, [role="main"], #root > *').count();
      await assert(content > 0, 'Import page content renders');

      // Should have source selection ("Select Import Source" heading and provider options)
      const hasHeading = await page.getByText('Select Import Source').count() > 0;
      const hasFileOption = await page.getByText('Upload Log File').count() > 0;
      await assert(hasHeading && hasFileOption, 'Import page has source selection UI');
    });

    // ── Back to home ───────────────────────────────────────────────────────
    await section('Navigation – Back to Home', async () => {
      await page.goto(`${BASE_URL}/#/`, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(500);
      const url = page.url();
      await assert(url.endsWith('/#/') || url.endsWith('/#'), 'Navigated back to home');
    });

    // ── Log search ─────────────────────────────────────────────────────────
    await section('Home Page – Search Interaction', async () => {
      const searchInput = page.locator('input[placeholder*="search" i], input[placeholder*="query" i], input[type="search"]').first();
      if (await searchInput.count() > 0) {
        await searchInput.click();
        await searchInput.fill('level:error');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        const filledValue = await searchInput.inputValue();
        await assert(filledValue === 'level:error', 'Search input accepts text and submits');

        // Clear search
        await searchInput.clear();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        const clearedValue = await searchInput.inputValue();
        await assert(clearedValue === '', 'Search cleared');
      } else {
        fail('Search interaction', new Error('no search input found'));
      }
    });

    // ── Date range picker ──────────────────────────────────────────────────
    await section('Home Page – Date Range Picker', async () => {
      const dateBtn = page.locator('button:has-text("Last"), button:has-text("Time"), button[aria-label*="date" i], button[aria-label*="time" i]').first();
      if (await dateBtn.count() > 0) {
        await dateBtn.click();
        await page.waitForTimeout(500);
        const pickerOpen = await page.locator('[role="dialog"], [role="listbox"], .popover, [data-state="open"]').count() > 0;
        await assert(pickerOpen, 'Date range picker opens');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const pickerClosed = await page.locator('[role="dialog"], [role="listbox"], .popover, [data-state="open"]').count() === 0;
        await assert(pickerClosed, 'Date picker closes on Escape');
      } else {
        ok('Date range picker not found (may require logs loaded)');
      }
    });

    // ── Sidebar/panel ──────────────────────────────────────────────────────
    await section('Home Page – Sidebar Panel', async () => {
      // Look for collapsible sidebar or panel toggle
      const panelToggle = page.locator('button[aria-label*="sidebar" i], button[aria-label*="panel" i], button[aria-label*="collapse" i]').first();
      if (await panelToggle.count() > 0) {
        const ariaExpandedBefore = await panelToggle.getAttribute('aria-expanded');
        await panelToggle.click();
        await page.waitForTimeout(300);
        const ariaExpandedAfter = await panelToggle.getAttribute('aria-expanded');
        await assert(ariaExpandedBefore !== ariaExpandedAfter, 'Sidebar toggle works');
      } else {
        ok('Sidebar toggle button not found (panel may always be visible)');
      }
    });

    // ── 404 page ───────────────────────────────────────────────────────────
    await section('404 Page – Unknown Route', async () => {
      await page.goto(`${BASE_URL}/#/definitely-does-not-exist`, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(500);
      const bodyText = await page.locator('body').innerText();
      const has404 = bodyText.toLowerCase().includes('not found') || bodyText.includes('404') || bodyText.includes('page not found');
      await assert(has404, '404/not-found page shown for unknown route');
    });

    // ── Screenshot ─────────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/tmp/logsonic-e2e.png', fullPage: true });
    console.log('\n  Screenshot saved to /tmp/logsonic-e2e.png');

  } finally {
    await context.close();
  }
}

// ─── Multi-file import tests ──────────────────────────────────────────────────
async function multiFileImportTests(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // ── Navigate to import page ────────────────────────────────────────────
    await section('Multi-File Import – Navigate to Import Page', async () => {
      await page.goto(`${BASE_URL}/#/import`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForSelector('text=Select Import Source', { timeout: 10000 });
      await assert(await page.getByText('Select Import Source').count() > 0, 'Import page loaded');
    });

    // ── Select file source ─────────────────────────────────────────────────
    await section('Multi-File Import – Select File Source', async () => {
      await page.getByText('Upload Log File').click();
      await page.waitForSelector('text=Drop your log files here', { timeout: 5000 });
      await assert(await page.locator('text=Drop your log files here').count() > 0, 'File drop zone visible');
      await assert(await page.locator('input[type="file"]').count() > 0, 'File input present');
    });

    // ── Upload multiple files ──────────────────────────────────────────────
    await section('Multi-File Import – Upload 3 Sample Log Files', async () => {
      await page.locator('input[type="file"]').setInputFiles([
        `${SAMPLE_LOGS_DIR}/nginx-access.log`,
        `${SAMPLE_LOGS_DIR}/apache.log`,
        `${SAMPLE_LOGS_DIR}/linux-syslog.log`,
      ]);

      // App auto-advances to Step 2 (pattern detection) once file preview is loaded
      await page.waitForSelector('text=Pattern Configuration', { timeout: 20000 });
      await assert(await page.getByText('Pattern Configuration').count() > 0, 'Auto-advanced to pattern detection step');
    });

    // ── Pattern detection ──────────────────────────────────────────────────
    await section('Multi-File Import – Auto-detect Patterns for Each File', async () => {
      // Wait for all files to finish detection (no "Detecting..." or "Queued" badges remain)
      await page.waitForFunction(() => {
        const body = document.body.innerText;
        return !body.includes('Detecting...') && !body.includes('Queued');
      }, { timeout: 30000 });
      await page.waitForTimeout(500);

      const matched = await page.getByText('Pattern found').count();
      const attention = await page.getByText('Manual selection needed').count();
      await assert(matched + attention === 3, `All 3 files have detection results (${matched} matched, ${attention} need attention)`);

      // Next button must be enabled (all files have selectedPattern and none still detecting)
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const next = btns.find(b => b.textContent?.trim() === 'Next');
        return next && !next.disabled;
      }, { timeout: 10000 });
      await assert(true, 'Next button enabled after detection');
    });

    // ── Advance to confirm step ────────────────────────────────────────────
    await section('Multi-File Import – Confirm Step UI', async () => {
      await page.getByRole('button', { name: 'Next' }).last().click();
      await page.waitForSelector('text=Files to Import', { timeout: 5000 });
      await assert(await page.getByText('Files to Import').count() > 0, '"Files to Import" header shown');

      // All 3 files should have checkboxes (pending state)
      const checkboxCount = await page.locator('[id^="file-check-"]').count();
      await assert(checkboxCount === 3, `3 per-file checkboxes shown (found ${checkboxCount})`);

      // Import button label should reflect the selected count
      await page.waitForSelector('button:has-text("Import 3 Files")', { timeout: 5000 });
      await assert(true, '"Import 3 Files" button visible');

      // Summary stats: 3 files card
      const threeCard = await page.getByText('3', { exact: true }).count();
      await assert(threeCard > 0, 'Summary shows "3" files');
    });

    // ── Trigger import and verify success ──────────────────────────────────
    await section('Multi-File Import – Import All Files', async () => {
      await page.getByRole('button', { name: 'Import 3 Files' }).last().click();

      // handleNext(step 3) runs handleMultiFileUpload then setCurrentStep(4)
      // Wait for step 4 to appear
      await page.waitForSelector('text=/Import Successful|Import Complete/', { timeout: 60000 });
      await assert(true, 'Import completed — success/complete screen shown');
    });

    // ── Verify success summary ─────────────────────────────────────────────
    await section('Multi-File Import – Success Summary', async () => {
      await page.waitForTimeout(300);

      // Overall success message
      const allSuccessMsg = await page.getByText(/All \d+ files have been successfully imported/i).count() > 0;
      const partialMsg = await page.getByText(/\d+ of \d+ files imported/i).count() > 0;
      await assert(allSuccessMsg || partialMsg, 'Success count message shown');

      // "Lines Processed" stat visible
      await assert(await page.getByText('Lines Processed').count() > 0, '"Lines Processed" stat shown');

      // Per-file result rows (one per file in the summary list)
      const resultRows = await page.locator('.border.rounded-lg.overflow-hidden.divide-y').last().locator('> div').count();
      await assert(resultRows === 3, `3 per-file result rows shown (found ${resultRows})`);

      // No critical JS errors during the full flow
      const critErrors = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('ollama') && !e.includes('ERR_CONNECTION_REFUSED')
      );
      await assert(critErrors.length === 0, `No critical JS errors during import (found ${critErrors.length})`);
    });

  } finally {
    await context.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Logsonic E2E Tests ===');
  console.log(`  Frontend: ${BASE_URL}`);
  console.log(`  Backend:  ${API_URL}`);

  await apiTests();

  const browser = await chromium.launch({ headless });
  try {
    await browserTests(browser);
    await multiFileImportTests(browser);
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
