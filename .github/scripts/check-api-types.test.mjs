#!/usr/bin/env node
// node:test, no framework -- run with: node .github/scripts/check-api-types.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractGoJsonFields, extractTsFieldNames, findMissing } from './check-api-types.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

test('extractGoJsonFields: reads names, skips "-", ignores omitempty', () => {
  const src = `
type T struct {
	A string ` + '`json:"a"`' + `
	B int    ` + '`json:"b,omitempty"`' + `
	C bool   ` + '`json:"-"`' + `
}`;
  assert.deepEqual([...extractGoJsonFields(src)].sort(), ['a', 'b']);
});

test('extractTsFieldNames: reads required and optional properties', () => {
  const src = `
export interface T {
  a: string;
  b?: number;
}`;
  assert.deepEqual([...extractTsFieldNames(src)].sort(), ['a', 'b']);
});

test('findMissing: reports Go fields absent from the TS set', () => {
  const missing = findMissing(new Set(['a', 'b', 'c']), new Set(['a', 'c']));
  assert.deepEqual(missing, ['b']);
});

test('findMissing: empty when every Go field is mirrored', () => {
  const missing = findMissing(new Set(['a', 'b']), new Set(['a', 'b', 'z']));
  assert.deepEqual(missing, []);
});

test('regression: real repo files have zero missing fields', () => {
  const goSource = readFileSync(path.join(repoRoot, 'backend/pkg/types/types.go'), 'utf8');
  const tsSource = readFileSync(path.join(repoRoot, 'frontend/src/lib/api-types.ts'), 'utf8');
  const missing = findMissing(extractGoJsonFields(goSource), extractTsFieldNames(tsSource));
  assert.deepEqual(missing, [], `unmirrored Go JSON field names: ${missing.join(', ')}`);
});
