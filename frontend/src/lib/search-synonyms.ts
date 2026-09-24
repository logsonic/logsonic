/**
 * A pre-built synonym dictionary for the search bar, and the pure helpers that
 * turn it into "did you also mean…" suggestions.
 *
 * Why a static dictionary rather than Bleve's own synonym support: a Bleve
 * synonym source is baked into an index's mapping and its definitions are
 * indexed as documents, so with one index per day every dictionary edit would
 * mean rebuilding every index. Suggesting terms in the UI instead costs
 * nothing at index time and leaves the user in control of their query.
 *
 * Everything here is pure and string-based so it can be unit-tested without a
 * store or a DOM, matching the shape of `query-clauses.ts`.
 *
 * ## What the query string actually supports
 *
 * Bleve's query-string parser has NO `OR` keyword and NO parentheses -- it
 * parses `(a OR b)` as three literal terms `(a`, `OR`, `b)`. What it does
 * have is an implicit disjunction: bare space-separated tokens all land in a
 * `should` clause. So expanding a search means *appending tokens*, nothing
 * more clever than that.
 *
 * ## Analyzer constraint on the dictionary
 *
 * The index uses Bleve's `standard` analyzer (storage.go), which runs an
 * English stop-word filter. Multi-word entries whose words are stop words
 * collapse to nothing useful -- "not found" analyzes to just `found`, "out of
 * memory" to just `memory`. Every term below was checked against Bleve's
 * `stop_words_en` list; such phrases are deliberately absent in favour of
 * their distinctive single-token forms (ENOENT, ENOMEM, OOMKilled).
 */

import { tokenizeQuery } from './query-clauses';

/**
 * Groups of terms that mean the same thing in logs. Matching any member of a
 * group suggests the other members, so groups are kept tight -- a term is only
 * grouped with terms a user would accept as the same search.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['error', 'err', 'errors', 'exception', 'fatal', 'panic', 'severe'],
  ['warning', 'warn', 'warnings'],
  ['failure', 'failed', 'fail', 'failing', 'crash', 'crashed'],
  // "timed out" survives the stop filter only as `timed`, which is still
  // distinctive enough to be worth offering alongside the compact spellings.
  ['timeout', 'timedout', 'timed out', 'etimedout', 'deadline'],
  ['denied', 'refused', 'rejected', 'forbidden', 'unauthorized'],
  ['missing', 'notfound', 'enoent', 'absent'],
  ['connection', 'conn', 'socket', 'econnreset', 'econnrefused', 'disconnected'],
  ['retry', 'retrying', 'retries', 'backoff'],
  ['oom', 'oomkilled', 'enomem'],
  ['unavailable', 'degraded', 'offline', 'unreachable'],
  ['throttled', 'ratelimit', 'throttling'],
  ['auth', 'authentication', 'authorization', 'unauthenticated', 'credentials'],
  ['nil', 'null', 'nullpointerexception', 'npe', 'undefined'],
  ['aborted', 'cancelled', 'canceled', 'terminated', 'killed', 'sigkill', 'sigterm'],
  ['invalid', 'malformed', 'corrupt', 'unparseable'],
];

/** term (lowercased) -> the group it belongs to. Built once at module load. */
const GROUP_BY_TERM = new Map<string, readonly string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) GROUP_BY_TERM.set(term.toLowerCase(), group);
}

/** How many chips a single query may produce, so the hint row stays readable. */
const MAX_SUGGESTIONS = 8;

export interface SynonymSuggestion {
  /** The sibling term being offered, e.g. `exception`. Used as the chip label. */
  term: string;
  /** The dictionary term in the query that triggered it, e.g. `error`. */
  matched: string;
  /** The exact token appended to the query, already scoped/quoted/negated. */
  insert: string;
}

/** Bleve accepts these unquoted before the colon; mirrors `query-clauses.ts`. */
const FIELD_PREFIX = /^([A-Za-z0-9_.]+):(.+)$/;
/** A bare word we are willing to look up. Excludes ranges, numbers, operators. */
const PLAIN_TERM = /^[A-Za-z0-9_]+$/;
/** Trailing `~2` (fuzziness) or `^3` (boost) modifiers, which are not part of the term. */
const TRAILING_MODIFIER = /[~^]\d*$/;

interface ParsedToken {
  /** '+' required, '-' excluded, or '' for a plain (should) token. */
  polarity: '+' | '-' | '';
  field?: string;
  /** The bare term, modifiers stripped, original case. */
  term: string;
}

/**
 * Pull the parts out of one query token, or return null if it is not a plain
 * term we can expand (a phrase, a regex, a range, a bare operator).
 */
const parseToken = (token: string): ParsedToken | null => {
  let rest = token;
  let polarity: '+' | '-' | '' = '';
  if (rest.startsWith('+') || rest.startsWith('-')) {
    polarity = rest[0] as '+' | '-';
    rest = rest.slice(1);
  }
  // Phrases and regexes are searched verbatim; there is no single term to look up.
  if (rest.startsWith('"') || rest.startsWith('/')) return null;

  let field: string | undefined;
  const fieldMatch = FIELD_PREFIX.exec(rest);
  if (fieldMatch) {
    field = fieldMatch[1];
    rest = fieldMatch[2];
    if (rest.startsWith('"') || rest.startsWith('/')) return null;
  }

  rest = rest.replace(TRAILING_MODIFIER, '');
  if (!PLAIN_TERM.test(rest)) return null;
  return { polarity, field, term: rest };
};

/** Quote a sibling only when it has to be: multi-word terms become phrases. */
const asQueryValue = (term: string): string => (/\s/.test(term) ? `"${term}"` : term);

/** Rebuild a token for a sibling term, keeping the original's field and polarity. */
const buildInsert = (parsed: ParsedToken, sibling: string): string => {
  const value = asQueryValue(sibling);
  const scoped = parsed.field ? `${parsed.field}:${value}` : value;
  // A '+' token is never expanded (see below), so polarity here is '' or '-'.
  return `${parsed.polarity}${scoped}`;
};

/**
 * Find the synonyms worth offering for a query.
 *
 * Only plain and excluded tokens are expanded:
 *
 *   - plain `error`  -> append `exception`. Bare tokens share one `should`
 *     clause, so appending means "match this as well", exactly the intent.
 *   - excluded `-error` -> append `-exception`. Both land in `must_not`, so
 *     the query excludes either -- again exactly the intent.
 *   - required `+error` -> skipped. The grammar cannot express "must match any
 *     of these"; appending `+exception` would demand *both*, and dropping the
 *     `+` would quietly demote the term to scoring-only whenever another `+`
 *     clause is present. Neither is what the user asked for, so we stay quiet.
 */
export const findSynonymSuggestions = (query: string): SynonymSuggestion[] => {
  if (!query.trim()) return [];

  const tokens = tokenizeQuery(query);
  const parsedTokens = tokens.map(parseToken);

  // Terms already somewhere in the query, so we never suggest a duplicate --
  // regardless of the field or polarity it appears under.
  const present = new Set<string>();
  for (const parsed of parsedTokens) {
    if (parsed) present.add(parsed.term.toLowerCase());
  }
  // Multi-word siblings appear as quoted phrases, which parseToken skips.
  for (const token of tokens) {
    const phrase = /^[+-]?(?:[A-Za-z0-9_.]+:)?"(.*)"$/.exec(token);
    if (phrase) present.add(phrase[1].toLowerCase());
  }

  const suggestions: SynonymSuggestion[] = [];
  const offered = new Set<string>();

  for (const parsed of parsedTokens) {
    if (!parsed || parsed.polarity === '+') continue;

    const group = GROUP_BY_TERM.get(parsed.term.toLowerCase());
    if (!group) continue;

    for (const sibling of group) {
      const key = sibling.toLowerCase();
      if (present.has(key) || offered.has(key)) continue;
      offered.add(key);
      suggestions.push({
        term: sibling,
        matched: parsed.term,
        insert: buildInsert(parsed, sibling),
      });
      if (suggestions.length >= MAX_SUGGESTIONS) return suggestions;
    }
  }

  return suggestions;
};

/**
 * Append a suggestion's token to the query. Appending (rather than splicing in
 * place) keeps every other token byte-identical, and token order is irrelevant
 * inside a `should` clause.
 */
export const applySynonymSuggestion = (query: string, suggestion: SynonymSuggestion): string => {
  const base = query.trimEnd();
  return base ? `${base} ${suggestion.insert}` : suggestion.insert;
};
