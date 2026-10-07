/**
 * Helpers for composing Bleve query-string clauses from facet values.
 *
 * A facet click adds `+field:"value"` (filter) or `-field:"value"` (exclude)
 * to the search bar; a second click removes it. Everything here is pure and
 * string-based so it can be unit-tested without a store or a DOM.
 */

/** Field names that Bleve's query-string parser accepts unquoted before the colon. */
const QUERYABLE_FIELD = /^[A-Za-z0-9_.]+$/;

export const isQueryableFieldName = (field: string): boolean => QUERYABLE_FIELD.test(field);

/** Escape a value for use inside double quotes: backslashes first, then quotes. */
export const escapeQueryValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export type ClausePolarity = '+' | '-';

/** A plain non-negative integer or decimal, e.g. `404` or `1.1`. */
const NUMERIC_VALUE = /^\d+(\.\d+)?$/;

const quotedFieldClause = (field: string, value: string, polarity: ClausePolarity): string =>
  `${polarity}${field}:"${escapeQueryValue(value)}"`;

/**
 * `+field:"value"` or `-field:"value"`, quoted so spaces and `:` survive.
 * Numeric values stay unquoted (`+status:404`): Bleve indexes numeric fields
 * as numbers and a quoted phrase never matches a number, while an unquoted
 * number matches both a numeric field and the same token in a text field.
 */
export const bleveFieldClause = (
  field: string,
  value: string,
  polarity: ClausePolarity = '+'
): string =>
  NUMERIC_VALUE.test(value)
    ? `${polarity}${field}:${value}`
    : quotedFieldClause(field, value, polarity);

/**
 * Every spelling of one clause: the canonical form plus, for a numeric value,
 * the quoted form older versions wrote, so a query saved before the change
 * still shows as active and is replaced rather than duplicated.
 */
const clauseSpellings = (field: string, value: string, polarity: ClausePolarity): string[] => {
  const canonical = bleveFieldClause(field, value, polarity);
  const quoted = quotedFieldClause(field, value, polarity);
  return canonical === quoted ? [canonical] : [canonical, quoted];
};

/**
 * Split a query into whitespace-separated tokens while keeping quoted
 * phrases (with escaped quotes) intact, so `+a:"x y" "z"` yields two tokens.
 */
export const tokenizeQuery = (query: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i];
    if (inQuotes) {
      current += ch;
      if (ch === '\\' && i + 1 < query.length) {
        current += query[i + 1];
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
};

export const queryHasClause = (query: string, clause: string): boolean =>
  tokenizeQuery(query).includes(clause);

/** Add the clause if absent, remove it if present. Other tokens are untouched. */
export const toggleQueryClause = (query: string, clause: string): string => {
  const tokens = tokenizeQuery(query);
  const next = tokens.includes(clause) ? tokens.filter((t) => t !== clause) : [...tokens, clause];
  return next.join(' ');
};

const siblingPolarity = (polarity: ClausePolarity): ClausePolarity =>
  polarity === '+' ? '-' : '+';

/**
 * The facet-click contract: compute the target clause, drop its `+`/`-`
 * twin if present (a value is either required or excluded, never both), then
 * toggle the target. Returns the new query and whether the clause is now on.
 */
export const setClausePolarity = (
  query: string,
  field: string,
  value: string,
  polarity: ClausePolarity
): { query: string; active: boolean } => {
  const target = bleveFieldClause(field, value, polarity);
  const twins = clauseSpellings(field, value, siblingPolarity(polarity));
  const legacy = clauseSpellings(field, value, polarity).filter((t) => t !== target);
  const tokens = tokenizeQuery(query).filter((t) => !twins.includes(t));
  // A legacy spelling of the target counts as "on": clicking turns it off.
  if (legacy.some((t) => tokens.includes(t))) {
    const next = tokens.filter((t) => !legacy.includes(t)).join(' ');
    return { query: next, active: false };
  }
  const next = toggleQueryClause(tokens.join(' '), target);
  return { query: next, active: queryHasClause(next, target) };
};

/** Which polarity, if any, the query currently applies to this field/value. */
export const clauseStateFor = (
  query: string,
  field: string,
  value: string
): ClausePolarity | null => {
  const tokens = tokenizeQuery(query);
  if (clauseSpellings(field, value, '+').some((t) => tokens.includes(t))) return '+';
  if (clauseSpellings(field, value, '-').some((t) => tokens.includes(t))) return '-';
  return null;
};
