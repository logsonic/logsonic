import { describe, expect, it } from 'vitest';

import { SYNONYM_GROUPS, applySynonymSuggestion, findSynonymSuggestions } from '../search-synonyms';

/** The tokens a query would gain if every suggestion were clicked. */
const inserts = (query: string) => findSynonymSuggestions(query).map((s) => s.insert);
const terms = (query: string) => findSynonymSuggestions(query).map((s) => s.term);

describe('SYNONYM_GROUPS', () => {
  it('never lists the same term in two groups', () => {
    const seen = new Set<string>();
    for (const group of SYNONYM_GROUPS) {
      for (const term of group) {
        expect(seen.has(term), `${term} appears in more than one group`).toBe(false);
        seen.add(term);
      }
    }
  });

  it('is lowercase throughout, so lookups need only lowercase the query term', () => {
    for (const group of SYNONYM_GROUPS) {
      for (const term of group) expect(term).toBe(term.toLowerCase());
    }
  });
});

describe('findSynonymSuggestions', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(findSynonymSuggestions('')).toEqual([]);
    expect(findSynonymSuggestions('   ')).toEqual([]);
  });

  it('returns nothing for a term that is not in the dictionary', () => {
    expect(findSynonymSuggestions('kubelet')).toEqual([]);
  });

  it('suggests the rest of the group for a plain term', () => {
    expect(terms('warning')).toEqual(['warn', 'warnings']);
  });

  it('matches case-insensitively but offers the dictionary spelling', () => {
    expect(terms('WARNING')).toEqual(['warn', 'warnings']);
    expect(terms('Warn')).toEqual(['warning', 'warnings']);
  });

  it('never suggests a term already in the query', () => {
    expect(terms('warning warn')).toEqual(['warnings']);
  });

  it('keeps the field scope of the token it matched', () => {
    expect(inserts('level:warning')).toEqual(['level:warn', 'level:warnings']);
  });

  it('keeps an exclusion, so both terms land in must_not', () => {
    expect(inserts('-warning')).toEqual(['-warn', '-warnings']);
  });

  it('skips a required term, which the grammar cannot expand', () => {
    expect(findSynonymSuggestions('+warning')).toEqual([]);
  });

  it('still expands the plain terms of a query that also has a required one', () => {
    expect(inserts('+level:ERROR warning')).toEqual(['warn', 'warnings']);
  });

  it('strips a fuzziness or boost modifier before looking the term up', () => {
    expect(terms('warning~1')).toEqual(['warn', 'warnings']);
    expect(terms('warning~')).toEqual(['warn', 'warnings']);
    expect(terms('warning^3')).toEqual(['warn', 'warnings']);
  });

  it('quotes a multi-word sibling so it stays one phrase', () => {
    expect(inserts('etimedout')).toContain('"timed out"');
  });

  it('scopes and quotes a multi-word sibling together', () => {
    expect(inserts('message:etimedout')).toContain('message:"timed out"');
  });

  it('does not re-suggest a multi-word term already quoted in the query', () => {
    expect(inserts('etimedout "timed out"')).not.toContain('"timed out"');
  });

  it('ignores phrases and regexes, which have no single term to look up', () => {
    expect(findSynonymSuggestions('"warning signs"')).toEqual([]);
    expect(findSynonymSuggestions('/warn.*/')).toEqual([]);
    expect(findSynonymSuggestions('level:"warning"')).toEqual([]);
  });

  it('ignores numeric comparisons and ranges', () => {
    expect(findSynonymSuggestions('status:>400')).toEqual([]);
    expect(findSynonymSuggestions('latency:<50')).toEqual([]);
  });

  it('deduplicates across two tokens from the same group', () => {
    expect(terms('warning warn')).toEqual(['warnings']);
  });

  it('caps the number of chips it offers', () => {
    expect(findSynonymSuggestions('error').length).toBeLessThanOrEqual(8);
  });

  it('reports which query term produced each suggestion', () => {
    const [first] = findSynonymSuggestions('Warning');
    expect(first.matched).toBe('Warning');
  });
});

describe('applySynonymSuggestion', () => {
  const apply = (query: string, term: string) => {
    const suggestion = findSynonymSuggestions(query).find((s) => s.term === term);
    if (!suggestion) throw new Error(`no suggestion for ${term}`);
    return applySynonymSuggestion(query, suggestion);
  };

  it('appends the token, leaving the rest of the query untouched', () => {
    expect(apply('warning', 'warn')).toBe('warning warn');
  });

  it('preserves other clauses verbatim', () => {
    expect(apply('+level:ERROR warning', 'warn')).toBe('+level:ERROR warning warn');
  });

  it('appends a scoped sibling with its field', () => {
    expect(apply('level:warning', 'warn')).toBe('level:warning level:warn');
  });

  it('appends an excluded sibling with its minus', () => {
    expect(apply('-warning', 'warn')).toBe('-warning -warn');
  });

  it('does not double the separating space', () => {
    expect(apply('warning   ', 'warn')).toBe('warning warn');
  });

  it('produces a query that suggests one fewer term next time', () => {
    const once = apply('warning', 'warn');
    expect(terms(once)).toEqual(['warnings']);
  });
});
