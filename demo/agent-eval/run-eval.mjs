// Agent detection eval: asks the agent dock to analyze the synthetic incident
// logs from generate_incidents.py, scores the answer against the ground truth,
// and screenshots every view (workspace) the agent saved. See README.md.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { chromium } = require('playwright');

const frontend = process.env.FRONTEND || 'http://127.0.0.1:5174';
const backend = process.env.BACKEND || 'http://127.0.0.1:8098';
const evalDir = process.env.EVAL_DIR || '/tmp/logsonic-agent-eval';
const out = process.env.ARTIFACTS || path.join(evalDir, 'artifacts');
const modes = (process.env.MODES || 'blind,hinted').split(',').map(s => s.trim()).filter(Boolean);
const turnTimeout = Number(process.env.TURN_TIMEOUT_MS || 660000);

const truth = JSON.parse(await readFile(path.join(evalDir, 'ground-truth.json'), 'utf8'));
const faults = Object.entries(truth).filter(([key]) => !key.startsWith('_'));
// A clean dataset (generate_incidents.py --clean) has no planted problems;
// every problem the agent confirms there is a false positive candidate.
const clean = faults.length === 0;
const logsDir = path.join(evalDir, 'logs');

const PROMPTS = {
  blind: `Import all logs from ${logsDir}. Then do a full analysis of everything that was imported. Something may be wrong but I do not know what. Find every real problem, separate it from routine background noise, and pinpoint each one: what happened, which source, which identifiers (accounts, IPs, versions, codes, routes), when it started and ended, and how many events. Save one view for each confirmed problem. Keep the final answer under 450 words.`,
  hinted: `The logs in this index are already imported; do not reimport. Check specifically for (1) a security intrusion, (2) payment failures and (3) a client-side UI bug. Look past routine background noise. For each, pinpoint what happened, which source, which identifiers (accounts, IPs, versions, browsers, codes, routes), when it started and ended, and how many events, or say that you found nothing. Save one view for each confirmed problem. Keep the final answer under 450 words.`,
};

// Asked after the investigation, so it cannot steer it: the agent restates
// its own conclusions in a form the harness can count.
const VERDICT_PROMPT = `Do not call any tools. List every problem you confirmed in your previous answer, one per line, exactly in the form "PROBLEM: <critical|high|medium|low|info> | <short title>". Use low or info for things that are noise, expected, or already resolved. If you confirmed no problems, write exactly "PROBLEM: none".`;

const parseVerdict = (answer) => {
  const claims = [];
  for (const m of answer.matchAll(/PROBLEM:\s*(critical|high|medium|low|info|none)\b\s*\|?\s*(.*)/gi)) {
    const severity = m[1].toLowerCase();
    if (severity !== 'none') claims.push({ severity, title: m[2].trim() });
  }
  return claims;
};
const SERIOUS = new Set(['critical', 'high', 'medium']);

const api = async (method, route, body) => {
  const res = await fetch(backend + '/api/v1' + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
  return data;
};

const listWorkspaces = async () => (await api('GET', '/workspaces')).workspaces || [];

// Rows a saved view shows, fetched with the same query, window and sources.
const viewRows = async (ws) => {
  const p = new URLSearchParams({ query: ws.query || '', limit: '50', sort_by: 'timestamp', sort_order: 'asc' });
  if (ws.time?.mode === 'absolute') {
    p.set('start_date', ws.time.start);
    p.set('end_date', ws.time.end);
  }
  if (ws.sources?.length) p.set('_src', ws.sources.join(','));
  const data = await api('GET', '/logs?' + p);
  return { total: data.total_count ?? 0, rows: data.logs || [] };
};

const lc = s => String(s).toLowerCase();
const has = (text, term) => lc(text).includes(lc(term));

// HH:MM mentions in the answer that fall inside the fault window (±10 min).
const mentionsWindow = (answer, window) => {
  const [from, to] = window.map(s => new Date(s).getTime());
  const day = new Date(window[0]).toISOString().slice(0, 10);
  for (const m of answer.matchAll(/\b([01]\d|2[0-3]):([0-5]\d)\b/g)) {
    const t = new Date(`${day}T${m[1]}:${m[2]}:00Z`).getTime();
    if (t >= from - 600000 && t <= to + 600000) return true;
  }
  return false;
};

const score = (fault, answer, steps, views) => {
  const ids = [...fault.required, ...fault.supporting];
  const detected = fault.detect_terms.some(t => has(answer, t)) && ids.some(id => has(answer, id));
  const requiredInAnswer = fault.required.filter(id => has(answer, id));
  const supportingInAnswer = fault.supporting.filter(id => has(answer, id));
  const stepText = JSON.stringify(steps.map(s => s.output));
  const grounded = fault.required.some(id => has(stepText, id));
  const timed = mentionsWindow(answer, fault.window);
  const pinpointed = detected && requiredInAnswer.length === fault.required.length && grounded && timed;
  const matchingViews = views.filter(v => v.matches.includes(fault.kind)).map(v => v.name);
  return { detected, pinpointed, required_in_answer: requiredInAnswer, supporting_in_answer: supportingInAnswer, grounded_in_tool_output: grounded, time_in_window: timed, views: matchingViews };
};

const askAgent = async (page, text) => {
  const turns = page.locator('.ls-turn');
  const before = await turns.count();
  await page.getByRole('textbox', { name: 'Message the agent' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const turn = turns.nth(before);
  await turn.locator('.ls-turn-meta, .ls-turn-error').first().waitFor({ timeout: turnTimeout });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('logsonic-agent') || '{}'));
  const session = saved.state.sessions.find(s => s.id === saved.state.activeId);
  const last = session.turns[session.turns.length - 1];
  const steps = last.items.filter(item => item.kind === 'step').map(item => item.step);
  return { answer: last.answer || '', error: last.error, steps };
};

const shoot = async (page, workspace, file) => {
  const res = await api('POST', '/ui/command', { type: 'open_workspace', args: { id: workspace.id }, timeout_ms: 15000 });
  if (res.status !== 'applied') throw new Error(`open_workspace ${workspace.name}: ${JSON.stringify(res)}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, file) });
};

const slug = s => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: out } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const report = { generated_at: new Date().toISOString(), backend, ground_truth: path.join(evalDir, 'ground-truth.json'), runs: {} };

try {
  await page.goto(frontend);
  await page.getByRole('button', { name: 'Agent', exact: true }).first().waitFor();
  for (const mode of modes) {
    // Each mode starts a fresh investigation, so the hinted run cannot read
    // the blind run's answer.
    await page.evaluate(() => localStorage.removeItem('logsonic-agent'));
    await page.reload();
    await page.getByRole('button', { name: 'Agent', exact: true }).first().waitFor();
    await page.keyboard.press('ControlOrMeta+j');
    await page.getByRole('heading', { name: 'Ask about your logs' }).waitFor();
    const before = new Set((await listWorkspaces()).map(w => w.id));
    const started = Date.now();
    const turn = await askAgent(page, PROMPTS[mode]);
    const seconds = Math.round((Date.now() - started) / 1000);
    await writeFile(path.join(out, `${mode}-turn.json`), JSON.stringify(turn, null, 2));
    await page.screenshot({ path: path.join(out, `${mode}-answer.png`) });

    const created = (await listWorkspaces()).filter(w => !before.has(w.id));
    const views = [];
    for (const ws of created) {
      const { total, rows } = await viewRows(ws);
      const rowText = JSON.stringify(rows);
      // A view covers a fault when its rows carry a required identifier and
      // a supporting one (for example the attacker IP and the export path).
      const matches = faults.filter(([, f]) => f.required.some(id => has(rowText, id)) && f.supporting.some(id => has(rowText, id))).map(([, f]) => f.kind);
      const file = `${mode}-view-${slug(ws.name)}.png`;
      await shoot(page, ws, file);
      views.push({ id: ws.id, name: ws.name, query: ws.query, sources: ws.sources, time: ws.time, total_rows: total, matches, screenshot: file });
    }
    const tools = {};
    for (const s of turn.steps) tools[s.tool] = (tools[s.tool] || 0) + 1;
    const scores = Object.fromEntries(faults.map(([key, f]) => [key, score(f, turn.answer, turn.steps, views)]));
    report.runs[mode] = { seconds, error: turn.error || null, tool_calls: turn.steps.length, tool_errors: turn.steps.filter(s => s.is_error).length, tools, views, scores, answer: turn.answer };
    if (clean) {
      const verdict = await askAgent(page, VERDICT_PROMPT);
      await writeFile(path.join(out, `${mode}-verdict.json`), JSON.stringify(verdict, null, 2));
      const claims = parseVerdict(verdict.answer);
      report.runs[mode].verdict = { answer: verdict.answer, tool_calls: verdict.steps.length, claims, false_positives: claims.filter(c => SERIOUS.has(c.severity)) };
    }
    console.log(JSON.stringify({ mode, seconds, tools, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { detected: v.detected, pinpointed: v.pinpointed, views: v.views.length }])), ...(clean ? { claims: report.runs[mode].verdict.claims, views: views.map(v => v.name) } : {}) }));
  }

  // Ground-truth views for any fault no agent view covered, clearly marked
  // as built by the harness rather than found by the agent.
  report.harness_views = [];
  for (const [key, fault] of faults) {
    const covered = Object.values(report.runs).some(run => run.scores[key].views.length > 0);
    if (covered) continue;
    const ws = (await api('POST', '/workspaces', {
      name: `[ground truth] ${fault.kind}`, description: fault.summary, query: fault.evidence_query, sources: fault.sources,
      time: { mode: 'absolute', start: fault.window[0], end: fault.window[1] }, sort_by: 'timestamp', sort_order: 'asc',
      visualization: { type: 'logs', bucket: 'auto' },
    })).workspace;
    const file = `harness-view-${key}.png`;
    await shoot(page, ws, file);
    report.harness_views.push({ fault: key, id: ws.id, screenshot: file });
  }
  report.page_errors = pageErrors;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

  const lines = ['# Agent detection eval', '', `Generated ${report.generated_at}. Ground truth: \`${report.ground_truth}\`.`, ''];
  if (clean) {
    lines.push('Clean dataset: no planted problems. A confirmed problem of medium severity or higher is a false positive.', '');
    lines.push('| Run | False positives (medium+) | Low/info findings | Views saved |', '|---|---|---|---|');
    for (const m of modes) {
      const run = report.runs[m];
      const fp = run.verdict.false_positives.map(c => `${c.severity}: ${c.title}`).join('<br>') || 'none';
      const low = run.verdict.claims.filter(c => !SERIOUS.has(c.severity)).map(c => `${c.severity}: ${c.title}`).join('<br>') || 'none';
      lines.push(`| ${m} | ${fp} | ${low} | ${run.views.map(v => `${v.name} (${v.total_rows})`).join('<br>') || 'none'} |`);
    }
  }
  lines.push('| Fault | ' + modes.map(m => `${m} detected | ${m} pinpointed | ${m} views`).join(' | ') + ' |');
  lines.push('|---|' + modes.map(() => '---|---|---').join('|') + '|');
  for (const [key] of faults) {
    lines.push(`| ${key} | ` + modes.map(m => {
      const s = report.runs[m].scores[key];
      return `${s.detected ? 'yes' : 'no'} | ${s.pinpointed ? 'yes' : 'no'} | ${s.views.length}`;
    }).join(' | ') + ' |');
  }
  for (const m of modes) {
    const run = report.runs[m];
    lines.push('', `## ${m}`, '', `${run.seconds}s, ${run.tool_calls} tool calls (${run.tool_errors} failed): ` + Object.entries(run.tools).map(([t, n]) => `${t}×${n}`).join(', '), '');
    if (run.error) lines.push(`Error: ${run.error}`, '');
    lines.push(run.answer, '');
    if (run.verdict) lines.push('Verdict turn:', '', '```', run.verdict.answer, '```', '');
  }
  await writeFile(path.join(out, 'report.md'), lines.join('\n'));
  console.log(`report: ${path.join(out, 'report.md')}`);
  if (pageErrors.length) console.warn(`browser exceptions: ${pageErrors.join('; ')}`);
} finally {
  await context.close();
  await browser.close();
}
