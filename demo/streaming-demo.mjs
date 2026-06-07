#!/usr/bin/env node
/**
 * LogSonic streaming demo.
 *
 * Starts local backend/frontend dev servers when needed, opens the real UI,
 * waits for the live listener, then streams synthetic log lines into the
 * live-tail API.
 *
 * Run:
 *   node demo/streaming-demo.mjs
 *
 * Useful knobs:
 *   ROWS=400 RATE=12 KEEP_OPEN=1 node demo/streaming-demo.mjs
 *   MODE=file node demo/streaming-demo.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs/promises';
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
const MODE = (process.env.MODE ?? 'stdin').trim().toLowerCase();
const SOURCE = process.env.SOURCE ?? `synthetic-${MODE}`;
const ROWS = parsePositiveInt(process.env.ROWS, 240);
const RATE = parsePositiveInt(process.env.RATE, 8);
const CLEAR = process.env.CLEAR;
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const HEADLESS = process.env.HEADLESS === '1';
const SLOWMO = parseNonNegativeInt(process.env.SLOWMO, 120);
const STARTDELAY = parseNonNegativeInt(process.env.STARTDELAY, 2);
const VERBOSE = process.env.VERBOSE === '1';
const WINDOW = process.env.WINDOW ?? '1440,900';
const WINDOW_POS = process.env.WINDOW_POS ?? '0,0';
const GENERATED_LOG = process.env.GENERATED_LOG
  ? path.resolve(process.env.GENERATED_LOG)
  : path.join(REPO, 'backend', 'tmp', 'streaming-demo.log');

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
  name: 'SYNTHETIC_STREAMING_DEMO',
  pattern: SYNTHETIC_PATTERN,
  source: SOURCE,
  smart_decoder: true,
  meta: {
    demo: 'streaming',
    generator: 'demo/streaming-demo.mjs',
    mode: MODE,
  },
};

const startedChildren = [];
let browser;
let liveSourceID;
let liveRequest;
let backendAutoStarted = false;
let shuttingDown = false;
let cleanupStarted = false;

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function log(message) {
  console.log(`\x1b[36m▸\x1b[0m ${message}`);
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
    const result = await Promise.race([
      once(child, 'exit').then(() => true),
      delay(ms).then(() => false),
    ]);
    return result;
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
  const storage = process.env.STORAGE_PATH ?? path.join(REPO, 'backend', 'tmp', 'streaming-demo-storage');
  log(`Starting backend on :${port}`);
  backendAutoStarted = true;
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
    env: { PORT: port },
  });
  await waitFor('frontend dev server', () => fetchOK(FRONTEND), 45000);
}

async function clearLogs() {
  const shouldClear = CLEAR === '1' || (CLEAR !== '0' && backendAutoStarted);
  if (!shouldClear) {
    if (CLEAR !== '0' && !backendAutoStarted) {
      log('Keeping logs on existing backend; set CLEAR=1 to clear before the demo');
    }
    return;
  }
  log('Clearing existing logs for a clean demo index');
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

  if (STARTDELAY > 0) {
    log(`UI ready; waiting for live listener in ${STARTDELAY}s`);
    await delay(STARTDELAY * 1000);
  }

  const liveIndicator = page.locator('.ls-live-indicator').first();
  await liveIndicator.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('.ls-live-indicator')?.textContent ?? '';
    return /Listening|Live|Paused/i.test(text);
  }, null, { timeout: 10000 });
  return page;
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

async function startFileSource() {
  await fs.mkdir(path.dirname(GENERATED_LOG), { recursive: true });
  await fs.writeFile(GENERATED_LOG, '');

  const response = await fetch(`${API}/live/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: GENERATED_LOG,
      options: liveOptions,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.source_id) {
    throw new Error(`live file source failed: ${body.error ?? response.status}`);
  }
  liveSourceID = body.source_id;
  await delay(500);
  return await fs.open(GENERATED_LOG, 'a');
}

async function stopFileSource() {
  if (!liveSourceID) return;
  await fetch(`${API}/live/sources/${encodeURIComponent(liveSourceID)}`, { method: 'DELETE' }).catch(() => null);
  liveSourceID = null;
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

  log(`Streaming ${ROWS.toLocaleString()} synthetic rows at ${RATE.toLocaleString()}/s via ${MODE}`);

  if (MODE === 'file') {
    log(`Writing generated log lines to ${GENERATED_LOG}`);
    const file = await startFileSource();
    try {
      for (let i = 0; i < ROWS; i++) {
        await file.write(`${syntheticLine(i, startTime)}\n`);
        if ((i + 1) % Math.max(RATE * 5, 1) === 0 || i + 1 === ROWS) {
          log(`  generated ${(i + 1).toLocaleString()} / ${ROWS.toLocaleString()}`);
        }
        await delay(intervalMs);
      }
    } finally {
      await file.close();
      await stopFileSource();
    }
    return;
  }

  if (MODE !== 'stdin') {
    throw new Error(`Unsupported MODE=${MODE}. Use MODE=stdin or MODE=file.`);
  }

  const { req, done } = openLiveStdinRequest();
  for (let i = 0; i < ROWS; i++) {
    await writeToRequest(req, syntheticLine(i, startTime));
    if ((i + 1) % Math.max(RATE * 5, 1) === 0 || i + 1 === ROWS) {
      log(`  generated ${(i + 1).toLocaleString()} / ${ROWS.toLocaleString()}`);
    }
    await delay(intervalMs);
  }
  req.end();
  liveRequest = null;
  await done;
}

async function verifyDemo(page) {
  await page.waitForFunction(
    () => /\b[1-9][0-9]* live\b/.test(document.body.innerText),
    null,
    { timeout: 15000 },
  );

  const response = await fetch(`${API}/logs?limit=1&query=demo:streaming`);
  const body = await response.json().catch(() => ({}));
  const total = body.total_count ?? body.total ?? 0;
  if (total <= 0) {
    throw new Error('Synthetic rows did not become searchable.');
  }
  log(`Verified ${total.toLocaleString()} searchable synthetic row(s)`);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  shuttingDown = true;
  if (liveRequest) {
    liveRequest.destroy();
    liveRequest = null;
  }
  await stopFileSource();
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
  await streamSyntheticRows();
  await verifyDemo(page);

  if (KEEP_OPEN) {
    log('Demo complete. Browser stays open; press Ctrl+C to stop auto-started servers.');
    await new Promise(() => {});
  }
}

try {
  await main();
} finally {
  await cleanup();
}
