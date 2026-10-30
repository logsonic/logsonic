// Run against the prototype servers; see agent-README.md.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { chromium } = require('playwright');
const url = process.env.FRONTEND || 'http://127.0.0.1:5173';
const out = process.env.ARTIFACTS || '/tmp/logsonic-agent-demo-artifacts';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: out } });
const page = await context.newPage();
// Sends a prompt through the agent dock and waits for the streamed turn to
// finish. Returns the completed turn as persisted by the dock (localStorage).
const askAgent = async (page, text) => {
  const turns = page.locator('.ls-turn');
  const before = await turns.count();
  await page.getByRole('textbox', { name: 'Message the agent' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const turn = turns.nth(before);
  await turn.locator('.ls-turn-meta, .ls-turn-error').first().waitFor({ timeout: 300000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('logsonic-agent') || '{}'));
  const session = saved.state.sessions.find(s => s.id === saved.state.activeId);
  const last = session.turns[session.turns.length - 1];
  const steps = last.items.filter(item => item.kind === 'step').map(item => item.step);
  return { answer: last.answer || '', error: last.error, steps };
};
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(url);
  await page.getByRole('button', { name: 'Agent', exact: true }).first().waitFor();
  await page.keyboard.press('ControlOrMeta+j');
  await page.getByRole('heading', { name: 'Ask about your logs' }).waitFor();
  await page.screenshot({ path: path.join(out, 'agent-start.png'), fullPage: true });
  const prompt = `Import all logs from ${path.join(root, 'demo/agent-logs')}. Find anomalies and correlate the incident across services using trace IDs and timestamps. Identify the likely cause with specific log evidence, counts, and uncertainty. Keep the answer under 300 words.`;
  const ask = async (text, file) => {
    const data = await askAgent(page, text);
    await writeFile(path.join(out, file), JSON.stringify(data, null, 2));
    if (data.error || !data.answer) throw new Error(JSON.stringify(data));
    return data;
  };
  const incident = await ask(prompt, 'incident.json');
  if (!incident.steps.some(s => s.tool === 'ingest_local')) throw new Error('No real ingestion tool call');
  if (!/pool|database/i.test(incident.answer)) throw new Error('Missing incident diagnosis');
  await page.screenshot({ path: path.join(out, 'agent-incident.png'), fullPage: true });
  const followup = await ask('Show the exact evidence for trace order-018 across all three services. Query the imported logs; do not reimport. Answer in under 150 words without dumping raw JSON.', 'followup.json');
  if (!followup.steps.some(s => s.tool === 'query_logs')) throw new Error('Followup did not query storage');
  if (followup.steps.some(s => s.tool.startsWith('ingest_'))) throw new Error('Followup reimported');
  const evidence = JSON.stringify(followup.steps);
  for (const source of ['checkout.jsonl', 'gateway.jsonl', 'payments.jsonl']) {
    if (!evidence.includes(source)) throw new Error(`Missing trace source ${source}`);
  }
  if (!evidence.includes('2026-10-28T10:18:00Z')) throw new Error('Trace event time was not preserved');
  await page.screenshot({ path: path.join(out, 'agent-followup.png'), fullPage: true });
  // Close and reopen the dock: the investigation must survive.
  await page.getByRole('button', { name: 'Close agent' }).click();
  await page.getByRole('complementary', { name: 'Agent panel' }).waitFor({ state: 'hidden' });
  await page.keyboard.press('ControlOrMeta+j');
  await page.getByText('Show the exact evidence for trace order-018', { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(out, 'logs-preserved.png'), fullPage: true });
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join('; ')}`);
  console.log(JSON.stringify({ success: true, actions: incident.steps.map(s => s.tool), followupActions: followup.steps.map(s => s.tool), artifacts: out }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
