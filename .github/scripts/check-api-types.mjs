#!/usr/bin/env node
// Mirror check (spec: specs/now-11-ci-quality-gate.md, phase 2, Q4): every
// JSON field name that appears on a Go DTO in backend/pkg/types/types.go
// should appear somewhere in the TS mirror, frontend/src/lib/api-types.ts.
//
// This is a name-presence check, not a structural one: it does not know
// which Go struct maps to which TS interface, so a Go field is considered
// "mirrored" if its JSON name appears as a property name ANYWHERE in
// api-types.ts. That means it cannot catch a field mirrored on the wrong
// interface, only a field missing everywhere. Warn-only for one release
// (see main() below) precisely because of that imprecision -- do not flip
// it to a failing exit code without tightening the check first.
//
// Usage: node .github/scripts/check-api-types.mjs
//   [--go <path>] [--ts <path>]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export function extractGoJsonFields(source) {
  const fields = new Set();
  for (const m of source.matchAll(/json:"([^",]+)/g)) {
    const name = m[1];
    if (name === '-') continue;
    fields.add(name);
  }
  return fields;
}

export function extractTsFieldNames(source) {
  const fields = new Set();
  // Interface/type body property lines: leading whitespace, an identifier,
  // an optional `?`, then `:`. Matches the style api-types.ts is written in
  // (one property per line, no destructuring, no computed keys).
  for (const m of source.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)) {
    fields.add(m[1]);
  }
  return fields;
}

export function findMissing(goFields, tsFields) {
  return [...goFields].filter((f) => !tsFields.has(f)).sort();
}

function parseArgs(argv) {
  const args = { go: 'backend/pkg/types/types.go', ts: 'frontend/src/lib/api-types.ts' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--go') args.go = argv[++i];
    else if (argv[i] === '--ts') args.ts = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const goPath = path.resolve(repoRoot, args.go);
  const tsPath = path.resolve(repoRoot, args.ts);

  const goSource = readFileSync(goPath, 'utf8');
  const tsSource = readFileSync(tsPath, 'utf8');

  const goFields = extractGoJsonFields(goSource);
  const tsFields = extractTsFieldNames(tsSource);
  const missing = findMissing(goFields, tsFields);

  if (missing.length === 0) {
    console.log(`check-api-types: ${goFields.size} Go JSON field names, all present in ${args.ts}`);
    return 0;
  }

  const warn = process.env.GITHUB_ACTIONS
    ? (msg) => console.log(`::warning::${msg}`)
    : (msg) => console.warn(msg);
  warn(
    `check-api-types: ${missing.length} Go JSON field name(s) not found anywhere in ${args.ts}: ${missing.join(', ')}`,
  );
  // Warn-only (see file header): exit 0 regardless of `missing`. Flip the
  // line below to `return missing.length === 0 ? 0 : 1;` once the check
  // has proven itself against a release or two of real drift.
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
