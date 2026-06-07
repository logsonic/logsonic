#!/usr/bin/env node
/**
 * LogSonic combined demo.
 *
 * Drives the real UI through the import/search flow, then starts a live stdin
 * stream so the live tile, live rows, Pause/Resume, skipped counts, and
 * immediate searchability are shown in one recording.
 *
 * Run:
 *   node demo/combined-demo.mjs
 *
 * Useful knobs:
 *   ROWS=240 RATE=16 KEEP_OPEN=1 node demo/combined-demo.mjs
 *   HEADLESS=1 STARTDELAY=0 STEPDELAY=100 ROWS=40 RATE=30 node demo/combined-demo.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const require = createRequire(path.join(REPO, 'frontend', 'node_modules', '_'));
const { chromium } = require('playwright');

const FRONTEND = stripTrailingSlash(process.env.FRONTEND ?? 'http://localhost:8081');
const BACKEND = stripTrailingSlash(process.env.BACKEND ?? 'http://localhost:8080');
const API = `${BACKEND}/api/v1`;
const FILES = (process.env.FILES
  ? process.env.FILES.split(',')
  : ['sample-logs/linux-syslog.log', 'sample-logs/apache.log']
).map((file) => (path.isAbsolute(file.trim()) ? file.trim() : path.join(REPO, file.trim())));
const FEATURE = path.basename(process.env.FEATURE ? process.env.FEATURE.trim() : FILES[0]);
const SEARCH = process.env.SEARCH ?? 'authentication failure';
const SOURCE = process.env.SOURCE ?? 'livestream-showcase';
const ROWS = parsePositiveInt(process.env.ROWS, 180);
const RATE = parsePositiveInt(process.env.RATE, 14);
const CLEAR = process.env.CLEAR === '1';
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const HEADLESS = process.env.HEADLESS === '1';
const SLOWMO = parseNonNegativeInt(process.env.SLOWMO, 180);
const STARTDELAY = parseNonNegativeInt(process.env.STARTDELAY, 4);
const STEPDELAY = parseNonNegativeInt(process.env.STEPDELAY, 1400);
const PAUSE_HOLD_MS = parseNonNegativeInt(process.env.PAUSE_HOLD_MS, HEADLESS ? 600 : 2500);
const ENDDELAY = parseNonNegativeInt(process.env.ENDDELAY, 5000);
const VERBOSE = process.env.VERBOSE === '1';
const WINDOW = process.env.WINDOW ?? '1440,900';
const WINDOW_POS = process.env.WINDOW_POS ?? '0,0';

const SYNTHETIC_PATTERN = [
  'ts=%{TIMESTAMP_ISO8601:timestamp}',
  'level=%{WORD:level}',
  'service=%{WORD:service}',
  'host=%{DATA:host}',
  'status=%{NUMBER:status}',
  'latency_ms=%{NUMBER:latency_ms}',
  'request_id=%{DATA:request_id}',
  'user=%{DATA:user}',
  'route=%{DATA:route}',
  'msg="%{GREEDYDATA:message}"',
].join(' ');

const liveOptions = {
  name: 'COMBINED_LIVESTREAM_DEMO',
  pattern: SYNTHETIC_PATTERN,
  source: SOURCE,
  smart_decoder: true,
  meta: {
    demo: 'combined-livestream',
    generator: 'demo/combined-demo.mjs',
  },
};

const startedChildren = [];
let browser;
let liveRequest;
let shuttingDown = false;
let cleanupStarted = false;

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function log(message) {
  console.log(`\x1b[36m>\x1b[0m ${message}`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseWindowSize() {
  const [width, height] = WINDOW.split(',').map((n) => Number.parseInt(n, 10));
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1440,
    height: Number.isFinite(height) && height > 0 ? height : 900,
  };
}

function isLocalhost(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function portFor(url) {
  const parsed = new URL(url);
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function fetchOK(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function startChild(label, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const tail = [];

  const capture = (streamName, data) => {
    const text = data.toString();
    tail.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${streamName}] ${line}`));
    if (tail.length > 80) tail.splice(0, tail.length - 80);
    if (VERBOSE) process.stdout.write(`[${label}] ${text}`);
  };

  child.stdout.on('data', (data) => capture('out', data));
  child.stderr.on('data', (data) => capture('err', data));
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`\n${label} exited early (${signal ?? `code ${code}`}).`);
      if (!VERBOSE && tail.length > 0) {
        console.error(tail.slice(-20).join('\n'));
      }
    }
  });

  startedChildren.push({ label, child });
  return child;
}

async function terminateChild(label, child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const signalTarget = process.platform === 'win32' ? child.pid : -child.pid;
  const sendSignal = (signal) => {
    try {
      process.kill(signalTarget, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  const waitForExit = async (ms) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await Promise.race([
      once(child, 'exit').then(() => true),
      delay(ms).then(() => false),
    ]);
  };

  sendSignal('SIGINT');
  if (await waitForExit(5000)) return;
  if (VERBOSE) log(`${label} did not exit after SIGINT; sending SIGTERM`);
  sendSignal('SIGTERM');
  if (await waitForExit(3000)) return;
  if (VERBOSE) log(`${label} did not exit after SIGTERM; sending SIGKILL`);
  sendSignal('SIGKILL');
  await waitForExit(1000);
}

async function ensureBackend() {
  if (await fetchOK(`${API}/ping`)) {
    log(`Using existing backend at ${BACKEND}`);
    return;
  }
  if (!isLocalhost(BACKEND)) {
    throw new Error(`Backend is not reachable at ${BACKEND}; auto-start only supports localhost URLs.`);
  }

  const port = portFor(BACKEND);
  const storage = process.env.STORAGE_PATH ?? path.join(REPO, 'backend', 'tmp', 'combined-demo-storage');
  log(`Starting backend on :${port}`);
  startChild('backend', 'go', ['run', '.', '-host', 'localhost', '-port', port, '-storage', storage], {
    cwd: path.join(REPO, 'backend'),
  });
  await waitFor('backend /ping', () => fetchOK(`${API}/ping`), 45000);
}

async function ensureFrontend() {
  if (await fetchOK(FRONTEND)) {
    log(`Using existing frontend at ${FRONTEND}`);
    return;
  }
  if (!isLocalhost(FRONTEND)) {
    throw new Error(`Frontend is not reachable at ${FRONTEND}; auto-start only supports localhost URLs.`);
  }

  const parsed = new URL(FRONTEND);
  const port = portFor(FRONTEND);
  log(`Starting frontend on :${port}`);
  startChild('frontend', npmCommand(), ['run', 'dev', '--', '--host', parsed.hostname, '--port', port], {
    cwd: path.join(REPO, 'frontend'),
    env: { PORT: port, VITE_API_BASE_URL: BACKEND },
  });
  await waitFor('frontend dev server', () => fetchOK(FRONTEND), 45000);
}

async function clearLogs() {
  if (!CLEAR) {
    log('Keeping existing logs; set CLEAR=1 for a clean combined demo');
    return;
  }
  log('Clearing existing logs for a clean combined demo');
  await fetch(`${API}/logs`, { method: 'DELETE' }).catch(() => null);
}

async function launchBrowser() {
  const { width, height } = parseWindowSize();
  const args = [`--window-position=${WINDOW_POS.replace(/\s/g, '')}`];
  if (process.env.FULLSCREEN === '1') {
    args.push('--start-fullscreen');
  } else if (process.env.MAXIMIZE === '1') {
    args.push('--start-maximized');
  } else {
    args.push(`--window-size=${width},${height}`);
  }

  browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : SLOWMO,
    args,
  });
  const context = await browser.newContext(HEADLESS ? { viewport: { width, height } } : { viewport: null });
  const page = await context.newPage();

  log('Opening LogSonic home');
  await page.goto(`${FRONTEND}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const idleLiveTiles = await page.locator('.ls-live-indicator').count();
  if (idleLiveTiles === 0) {
    log('Live tile is hidden before any live source starts');
  } else {
    log('Live tile is already visible; an existing live source may be active');
  }

  if (STARTDELAY > 0) {
    log(`UI ready; actions begin in ${STARTDELAY}s`);
    await delay(STARTDELAY * 1000);
  }
  return page;
}

async function step(page, multiplier = 1) {
  await page.waitForTimeout(STEPDELAY * multiplier);
}

async function openImportWizard(page) {
  log('Opening Import wizard');
  const importRail = page.getByRole('button', { name: 'Import', exact: true });
  if (await importRail.count()) {
    await importRail.first().click();
  } else {
    await page.goto(`${FRONTEND}/#/import`, { waitUntil: 'domcontentloaded' });
  }
  await page.getByText('Import logs', { exact: true }).waitFor({ timeout: 10000 });
  await step(page);
}

async function getImportButton(page) {
  const counted = page.getByRole('button', { name: /^Import\s+\d+\s+Files?$/ }).first();
  if (await counted.count()) return counted;
  return page.getByRole('button', { name: /^Import$/ }).last();
}

async function settleTimestampGate(page) {
  const fileRow = page.getByText(FEATURE).first();
  if (await fileRow.isVisible().catch(() => false)) {
    log(`Opening "${FEATURE}" details`);
    await fileRow.scrollIntoViewIfNeeded().catch(() => {});
    await fileRow.click().catch(() => {});
    await step(page);
  }

  const settingsBtn = page.getByRole('button', { name: /Settings/ }).first();
  if (await settingsBtn.isVisible().catch(() => false)) {
    log('Showing timestamp settings');
    await settingsBtn.scrollIntoViewIfNeeded().catch(() => {});
    await settingsBtn.click();
    await step(page, 2);
  }

  const confirmBtn = page.getByRole('button', { name: 'Looks correct' }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    log('Confirming resolved timestamps');
    await confirmBtn.scrollIntoViewIfNeeded().catch(() => {});
    await confirmBtn.click();
    await step(page);
  }
}

async function importSampleLogs(page) {
  await openImportWizard(page);

  log(`Selecting ${FILES.length} file(s): ${FILES.map((file) => path.basename(file)).join(', ')}`);
  await page.locator('input[type="file"]').first().setInputFiles(FILES);
  await step(page);

  const nextBtn = page.getByRole('button', { name: 'Next', exact: true });
  if (await nextBtn.isVisible().catch(() => false)) {
    if (await nextBtn.isEnabled().catch(() => false)) await nextBtn.click();
  }
  await step(page);

  log('Waiting for pattern detection');
  const importBtn = await getImportButton(page);
  await importBtn.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button')];
    const imp = buttons.find((button) => /^Import\s+\d+\s+Files?$/.test(button.textContent?.trim() ?? ''));
    const hasSettings = buttons.some((button) => /Settings/.test(button.textContent ?? ''));
    return (imp && !imp.disabled) || hasSettings;
  }, null, { timeout: 30000 }).catch(() => {});

  await settleTimestampGate(page);

  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      /^Import\s+\d+\s+Files?$/.test(item.textContent?.trim() ?? ''),
    );
    return button && !button.disabled;
  }, null, { timeout: 20000 });

  log('Importing sample logs');
  await importBtn.scrollIntoViewIfNeeded().catch(() => {});
  await importBtn.click();

  const skipSave = page.getByRole('button', { name: 'Skip & Continue', exact: true }).first();
  if (await skipSave.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    log('Skipping optional pattern save');
    await skipSave.click();
  }

  const homeBtn = page.getByRole('button', { name: 'Home', exact: true });
  await homeBtn.waitFor({ timeout: 30000 });
  await step(page);
  await homeBtn.click();
  await step(page);
}

async function searchImportedLogs(page) {
  log(`Searching imported logs for "${SEARCH}"`);
  const search = page.getByPlaceholder(/Search logs/i);
  await search.waitFor({ timeout: 10000 });
  await search.click();
  await page.keyboard.type(SEARCH, { delay: HEADLESS ? 0 : 35 });
  await page.keyboard.press('Enter');
  await step(page, 2);
}

function encodedLiveOptions() {
  return Buffer.from(JSON.stringify(liveOptions), 'utf8').toString('base64');
}

function openLiveStdinRequest() {
  const endpoint = new URL(`${API}/live/stdin`);
  const client = endpoint.protocol === 'https:' ? https : http;

  let req;
  const done = new Promise((resolve, reject) => {
    req = client.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Logsonic-Live-Options': encodedLiveOptions(),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`live stdin failed with HTTP ${res.statusCode}: ${body.trim()}`));
        }
      });
    });
    req.on('error', reject);
  });

  liveRequest = req;
  return { req, done };
}

async function writeToRequest(req, line) {
  if (!req.write(`${line}\n`)) {
    await once(req, 'drain');
  }
}

function syntheticLine(index, startTime) {
  const services = ['gateway', 'orders', 'billing', 'search', 'auth', 'worker'];
  const routes = ['/api/orders', '/api/cart', '/api/checkout', '/api/search', '/api/session', '/jobs/reconcile'];
  const hosts = ['edge-01', 'edge-02', 'app-01', 'app-02', 'worker-01'];
  const level = index % 29 === 0 ? 'ERROR' : index % 11 === 0 ? 'WARN' : 'INFO';
  const status = level === 'ERROR' ? 503 : level === 'WARN' ? 429 : [200, 201, 202, 204][index % 4];
  const service = services[index % services.length];
  const route = routes[(index * 3) % routes.length];
  const host = hosts[(index * 5 + 2) % hosts.length];
  const latency = level === 'ERROR'
    ? 900 + (index % 13) * 37
    : level === 'WARN'
      ? 250 + (index % 9) * 21
      : 20 + (index % 17) * 7;
  const requestID = `req-${String(index + 1).padStart(6, '0')}`;
  const user = `user-${1000 + (index * 17) % 9000}`;
  const timestamp = new Date(startTime.getTime() + index * 1000).toISOString();
  const message = level === 'ERROR'
    ? `${service} upstream timeout while handling ${route}`
    : level === 'WARN'
      ? `${service} throttled request burst on ${route}`
      : `${service} completed ${route}`;

  return [
    `ts=${timestamp}`,
    `level=${level}`,
    `service=${service}`,
    `host=${host}`,
    `status=${status}`,
    `latency_ms=${latency}`,
    `request_id=${requestID}`,
    `user=${user}`,
    `route=${route}`,
    `msg="${message}"`,
  ].join(' ');
}

async function streamSyntheticRows() {
  const intervalMs = Math.max(1, Math.round(1000 / RATE));
  const startTime = new Date();
  const { req, done } = openLiveStdinRequest();

  log(`Streaming ${ROWS.toLocaleString()} live rows at ${RATE.toLocaleString()}/s`);
  for (let i = 0; i < ROWS; i++) {
    await writeToRequest(req, syntheticLine(i, startTime));
    if ((i + 1) % Math.max(RATE * 5, 1) === 0 || i + 1 === ROWS) {
      log(`  streamed ${(i + 1).toLocaleString()} / ${ROWS.toLocaleString()}`);
    }
    await delay(intervalMs);
  }
  req.end();
  liveRequest = null;
  await done;
}

async function waitForLiveTile(page) {
  const liveIndicator = page.locator('.ls-live-indicator').first();
  await liveIndicator.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('.ls-live-indicator')?.textContent ?? '';
    return /Live|Paused|Listening/i.test(text);
  }, null, { timeout: 15000 });
}

async function waitForEnabledButton(page, label) {
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll('button')].some((button) => {
      return button.textContent?.includes(name) && !button.disabled;
    });
  }, label, { timeout: 15000 });
  return page.getByRole('button', { name: label, exact: true }).first();
}

async function showcaseLivestream(page) {
  log('Starting Livestream showcase');
  const streamPromise = streamSyntheticRows();

  await waitForLiveTile(page);
  log('Live tile appeared when the source started');
  await step(page);

  const pauseBtn = await waitForEnabledButton(page, 'Pause');
  log('Pausing the browser subscriber while ingestion continues');
  await pauseBtn.click();
  await page.waitForFunction(
    () => /Paused/i.test(document.querySelector('.ls-live-indicator')?.textContent ?? ''),
    null,
    { timeout: 10000 },
  );
  await delay(PAUSE_HOLD_MS);

  const resumeBtn = await waitForEnabledButton(page, 'Resume');
  log('Resuming live rows and showing skipped count');
  await resumeBtn.click();

  await streamPromise;
  await page.waitForFunction(
    () => /\b[1-9][0-9]* live\b/.test(document.body.innerText),
    null,
    { timeout: 15000 },
  );
  await step(page, 2);
}

async function verifyDemo() {
  const response = await fetch(`${API}/logs?limit=1&query=demo:combined-livestream`);
  const body = await response.json().catch(() => ({}));
  const total = body.total_count ?? body.total ?? 0;
  if (total <= 0) {
    throw new Error('Combined livestream rows did not become searchable.');
  }
  log(`Verified ${total.toLocaleString()} searchable livestream row(s)`);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  shuttingDown = true;
  if (liveRequest) {
    liveRequest.destroy();
    liveRequest = null;
  }
  if (browser && !KEEP_OPEN) {
    await browser.close().catch(() => {});
  }
  for (const { label, child } of startedChildren.reverse()) {
    await terminateChild(label, child);
  }
}

async function main() {
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  await ensureBackend();
  await ensureFrontend();
  await clearLogs();
  const page = await launchBrowser();
  await importSampleLogs(page);
  await searchImportedLogs(page);
  await showcaseLivestream(page);
  await verifyDemo();

  log('Combined demo complete');
  if (KEEP_OPEN) {
    log('KEEP_OPEN set. Browser stays open; press Ctrl+C to stop auto-started servers.');
    await new Promise(() => {});
  }
  if (ENDDELAY > 0) {
    await delay(ENDDELAY);
  }
}

try {
  await main();
} finally {
  await cleanup();
}
