#!/usr/bin/env node
// node:test, no framework -- run with: node .github/scripts/compare-bench.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareScenario, compareBench } from './compare-bench.mjs';

function latency(name, p95) {
  return { name, direction: 'lower_is_better', p95 };
}

function throughput(name, value) {
  return { name, direction: 'higher_is_better', value };
}

test('compareScenario: within tolerance does not regress', () => {
  const result = compareScenario(latency('search_term_common', 100), latency('search_term_common', 110));
  assert.equal(result.regression, false);
  assert.ok(Math.abs(result.deltaPct - 10) < 0.001);
});

test('compareScenario: lower_is_better regresses beyond +15%', () => {
  const result = compareScenario(latency('search_term_common', 100), latency('search_term_common', 120));
  assert.equal(result.regression, true);
});

test('compareScenario: lower_is_better improvement never regresses', () => {
  const result = compareScenario(latency('search_term_common', 100), latency('search_term_common', 50));
  assert.equal(result.regression, false);
  assert.ok(result.deltaPct < 0);
});

test('compareScenario: higher_is_better regresses when it drops beyond -15%', () => {
  const result = compareScenario(throughput('import_throughput', 1000), throughput('import_throughput', 800));
  assert.equal(result.regression, true);
});

test('compareScenario: higher_is_better improvement never regresses', () => {
  const result = compareScenario(throughput('import_throughput', 1000), throughput('import_throughput', 1500));
  assert.equal(result.regression, false);
});

test('compareBench: scenario missing from current is reported, not a regression', () => {
  const baseline = { scenarios: [latency('gone', 100)] };
  const current = { scenarios: [] };
  const rows = compareBench(baseline, current);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'gone');
  assert.equal(rows[0].regression, false);
});

test('compareBench: new scenario in current is reported, not a regression', () => {
  const baseline = { scenarios: [] };
  const current = { scenarios: [latency('new_scenario', 100)] };
  const rows = compareBench(baseline, current);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'new_scenario');
  assert.equal(rows[0].regression, false);
});
