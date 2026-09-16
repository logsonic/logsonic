#!/usr/bin/env node
// Regression gate for the now-11 §8 bench harness (spec: phase 2,
// "A compare.mjs script prints deltas against a baseline file and exits
// non-zero beyond +/-15%% -- wired into nightly only").
//
// Scenarios carry their own `direction` (backend/bench/scenarios.go):
// "lower_is_better" (latency) fails only when current is MORE than 15% worse
// (higher) than baseline; "higher_is_better" (throughput) fails only when
// current is more than 15% worse (lower). An improvement never fails the
// gate -- §8 says this is a regression check, not a two-sided tolerance
// band, so a 20% latency improvement passing is correct, not a bug.
//
// A scenario present in baseline but absent from current (or vice versa) is
// reported, not a failure by itself -- the harness's scenario set is
// expected to grow (this phase's own "Deferred" list names two).
//
// Usage: node .github/scripts/compare-bench.mjs <baseline.json> <current.json>

import { readFileSync } from 'node:fs';

const TOLERANCE = 0.15;

export function metricValue(scenario) {
  // Latency scenarios report p95 (the budget-relevant number); throughput
  // and single-value scenarios (storage_open_ms) report `value`.
  return typeof scenario.p95 === 'number' ? scenario.p95 : scenario.value;
}

export function compareScenario(baseline, current) {
  const base = metricValue(baseline);
  const curr = metricValue(current);
  if (typeof base !== 'number' || typeof curr !== 'number' || base === 0) {
    return { name: current.name, base, curr, deltaPct: null, regression: false };
  }
  const deltaPct = ((curr - base) / base) * 100;
  const worse = current.direction === 'higher_is_better' ? deltaPct < 0 : deltaPct > 0;
  const regression = worse && Math.abs(deltaPct) > TOLERANCE * 100;
  return { name: current.name, base, curr, deltaPct, regression };
}

export function compareBench(baselineDoc, currentDoc) {
  const baselineByName = new Map(baselineDoc.scenarios.map((s) => [s.name, s]));
  const currentByName = new Map(currentDoc.scenarios.map((s) => [s.name, s]));

  const rows = [];
  for (const [name, current] of currentByName) {
    const baseline = baselineByName.get(name);
    if (!baseline) {
      rows.push({ name, base: null, curr: metricValue(current), deltaPct: null, regression: false });
      continue;
    }
    rows.push(compareScenario(baseline, current));
  }
  for (const name of baselineByName.keys()) {
    if (!currentByName.has(name)) {
      rows.push({ name, base: metricValue(baselineByName.get(name)), curr: null, deltaPct: null, regression: false });
    }
  }
  return rows;
}

function formatRow(row) {
  const delta = row.deltaPct === null ? 'n/a' : `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`;
  const flag = row.regression ? '  <-- REGRESSION (>15%)' : '';
  return `${row.name}: baseline=${row.base ?? 'n/a'} current=${row.curr ?? 'n/a'} delta=${delta}${flag}`;
}

function main(argv) {
  const [baselinePath, currentPath] = argv;
  if (!baselinePath || !currentPath) {
    console.error('usage: compare-bench.mjs <baseline.json> <current.json>');
    return 2;
  }
  const baselineDoc = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const currentDoc = JSON.parse(readFileSync(currentPath, 'utf8'));
  const rows = compareBench(baselineDoc, currentDoc);

  console.log(`compare-bench: ${baselinePath} -> ${currentPath}`);
  for (const row of rows) console.log('  ' + formatRow(row));

  const regressions = rows.filter((r) => r.regression);
  if (regressions.length > 0) {
    console.error(`compare-bench: ${regressions.length} scenario(s) regressed beyond +/-15%`);
    return 1;
  }
  console.log('compare-bench: no regressions beyond tolerance');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
