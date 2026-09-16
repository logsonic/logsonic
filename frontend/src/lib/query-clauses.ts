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

/** `+field:"value"` or `-field:"value"`, always quoted so spaces and `:` survive. */
export const bleveFieldClause = (field: string, value: string, polarity: ClausePolarity = '+'): string =>
  `${polarity}${field}:"${escapeQueryValue(value)}"`;

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

const siblingPolarity = (polarity: ClausePolarity): ClausePolarity => (polarity === '+' ? '-' : '+');

/**
 * The facet-click contract: compute the target clause, drop its `+`/`-`
 * twin if present (a value is either required or excluded, never both), then
 * toggle the target. Returns the new query and whether the clause is now on.
 */
export const setClausePolarity = (
  query: string,
  field: string,
  value: string,
  polarity: ClausePolarity,
): { query: string; active: boolean } => {
  const target = bleveFieldClause(field, value, polarity);
  const twin = bleveFieldClause(field, value, siblingPolarity(polarity));
  const withoutTwin = tokenizeQuery(query).filter((t) => t !== twin).join(' ');
  const next = toggleQueryClause(withoutTwin, target);
  return { query: next, active: queryHasClause(next, target) };
};

/** Which polarity, if any, the query currently applies to this field/value. */
export const clauseStateFor = (query: string, field: string, value: string): ClausePolarity | null => {
  const tokens = tokenizeQuery(query);
  if (tokens.includes(bleveFieldClause(field, value, '+'))) return '+';
  if (tokens.includes(bleveFieldClause(field, value, '-'))) return '-';
  return null;
};
