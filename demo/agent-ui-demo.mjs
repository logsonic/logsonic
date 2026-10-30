// Uses the running demo index populated by agent-demo.mjs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { chromium } = require('playwright');
const artifacts = process.env.ARTIFACTS || '/tmp/logsonic-agent-demo-artifacts';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
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
try {
  // #/agent opens the agent dock beside the log view.
  await page.goto(`${process.env.FRONTEND || 'http://127.0.0.1:5173'}/#/agent`);
  const data = await askAgent(
    page,
    'Use the MCP UI methods to show only ERROR logs from payments.jsonl for 2026-10-28 10:00–11:00 UTC. Set columns to timestamp, message, level, service, trace_id. Do not import. Confirm the matching row count in under 80 words.'
  );
  await writeFile(path.join(artifacts, 'ui-control.json'), JSON.stringify(data, null, 2));
  if (data.error || !data.answer) throw new Error(JSON.stringify(data));
  if (!data.steps.some(step => step.tool.startsWith('ui_'))) throw new Error('No MCP UI tool was called');
  // The chat docks beside the table: both stay visible while the agent drives the view.
  await page.getByRole('complementary', { name: 'Agent panel' }).waitFor();
  const search = page.locator('input[aria-label="Search logs"]');
  if (!(await search.isVisible())) throw new Error('Search bar should stay visible beside the agent');
  if (!/error/i.test(await search.inputValue())) throw new Error('UI query was not applied');
  if (!/6\s+matches/.test(await page.locator('body').innerText())) throw new Error('Expected 6 matching payments failures');
  if (!(await page.locator('.ls-step.is-on-screen').count())) throw new Error('The step driving the table is not marked');
  await page.screenshot({ path: path.join(artifacts, 'agent-ui-controlled.png'), fullPage: true });
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify({ passed: true, tools: data.steps.map(step => step.tool), answer: data.answer, artifacts }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
