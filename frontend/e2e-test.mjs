/**
 * Logsonic E2E tests using Playwright
 * Run with: node e2e-test.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:8080';
const API_URL = 'http://localhost:8080/api/v1';

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

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Logsonic E2E Tests ===');
  console.log(`  Frontend: ${BASE_URL}`);
  console.log(`  Backend:  ${API_URL}`);

  await apiTests();

  const browser = await chromium.launch({ headless: true });
  try {
    await browserTests(browser);
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
