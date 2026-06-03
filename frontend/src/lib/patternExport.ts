// Versioned import/export format for saved Grok patterns.
//
// Future-proofing strategy:
//  - Every export is wrapped in an envelope carrying a stable `kind`
//    discriminator and an integer `schemaVersion`. Readers key off these
//    rather than guessing from shape.
//  - The importer is lenient: it accepts the current envelope, older
//    envelopes (routed through `migrate`), a bare array of patterns
//    (hand-authored / pre-envelope files), and tolerates unknown fields.
//  - When the schema changes, bump CURRENT_SCHEMA_VERSION and add a case to
//    `migrate()`. Forward-compat: a newer file imports best-effort (known
//    fields only) with a warning instead of failing outright.
//  - `timestamp_config` is passed through untouched so additive changes to
//    that nested type survive a round-trip without code changes here.

import { GrokPatternRequest } from './api-types';

export const PATTERNS_EXPORT_KIND = 'logsonic.grok-patterns';
export const CURRENT_SCHEMA_VERSION = 1;

export interface PatternsExportEnvelope {
  kind: typeof PATTERNS_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  patterns: GrokPatternRequest[];
}

export interface ParsedImport {
  patterns: GrokPatternRequest[];
  /** Non-fatal notes surfaced to the user (skipped entries, version drift, …). */
  warnings: string[];
}

/** Build a canonical, pretty-printable export envelope from saved patterns. */
export function buildPatternsExport(patterns: GrokPatternRequest[]): PatternsExportEnvelope {
  return {
    kind: PATTERNS_EXPORT_KIND,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    // Re-map to a stable, known field set so exports stay canonical even if
    // the in-memory objects pick up extra keys over time.
    patterns: patterns.map(canonicalPattern),
  };
}

function canonicalPattern(p: GrokPatternRequest): GrokPatternRequest {
  const out: GrokPatternRequest = {
    name: p.name,
    pattern: p.pattern,
    description: p.description || '',
    priority: p.priority || 0,
    custom_patterns: p.custom_patterns || {},
  };
  if (p.timestamp_config) out.timestamp_config = p.timestamp_config;
  return out;
}

/**
 * Parse and normalize the contents of an import file. Throws only on
 * unrecoverable problems (not JSON, wrong kind, no usable patterns); anything
 * recoverable becomes a warning so a partially-valid file still imports.
 */
export function parsePatternsImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }

  const warnings: string[] = [];
  let rawPatterns: unknown;
  let schemaVersion = CURRENT_SCHEMA_VERSION;

  if (Array.isArray(data)) {
    // Pre-envelope / hand-authored file: a bare array of patterns.
    rawPatterns = data;
    warnings.push('No envelope found — imported as a raw pattern array.');
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    if (typeof obj.kind === 'string' && obj.kind !== PATTERNS_EXPORT_KIND) {
      throw new Error(`Unrecognized file kind "${obj.kind}".`);
    }

    if (typeof obj.schemaVersion === 'number') {
      schemaVersion = obj.schemaVersion;
      if (obj.schemaVersion > CURRENT_SCHEMA_VERSION) {
        warnings.push(
          `File is schema v${obj.schemaVersion}, newer than supported v${CURRENT_SCHEMA_VERSION} — importing known fields only.`
        );
      }
    }

    // Tolerate the canonical key plus a couple of plausible aliases.
    rawPatterns = obj.patterns ?? obj.grok_patterns ?? obj.data;
  } else {
    throw new Error('Unexpected JSON structure.');
  }

  if (!Array.isArray(rawPatterns)) {
    throw new Error('No "patterns" array found in the file.');
  }

  const patterns: GrokPatternRequest[] = [];
  rawPatterns.forEach((entry, i) => {
    const normalized = normalizeEntry(migrate(entry, schemaVersion), i, warnings);
    if (normalized) patterns.push(normalized);
  });

  if (patterns.length === 0) {
    throw new Error('No valid patterns found in the file.');
  }

  return { patterns, warnings };
}

/**
 * Bring a single raw entry from `fromVersion` up to the current schema.
 * Identity today; the switch is the extension point for future migrations.
 */
function migrate(entry: unknown, fromVersion: number): unknown {
  const e = entry;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    switch (v) {
      // case 1: e = upgradeV1toV2(e); break;
      default:
        break;
    }
  }
  return e;
}

function normalizeEntry(
  entry: unknown,
  idx: number,
  warnings: string[]
): GrokPatternRequest | null {
  if (!entry || typeof entry !== 'object') {
    warnings.push(`Entry ${idx + 1} skipped — not an object.`);
    return null;
  }
  const e = entry as Record<string, unknown>;

  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const pattern = typeof e.pattern === 'string' ? e.pattern : '';

  if (!name) {
    warnings.push(`Entry ${idx + 1} skipped — missing "name".`);
    return null;
  }
  if (!pattern.trim()) {
    warnings.push(`"${name}" skipped — missing "pattern" body.`);
    return null;
  }

  const result: GrokPatternRequest = {
    name,
    pattern,
    description: typeof e.description === 'string' ? e.description : '',
    priority: typeof e.priority === 'number' ? e.priority : 0,
    custom_patterns: isStringRecord(e.custom_patterns) ? e.custom_patterns : {},
  };

  // Pass nested timestamp config through unchanged for forward-compat.
  if (e.timestamp_config && typeof e.timestamp_config === 'object') {
    result.timestamp_config = e.timestamp_config as GrokPatternRequest['timestamp_config'];
  }

  return result;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  );
}
