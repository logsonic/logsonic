import { describe, expect, it } from 'vitest';

import {
  bleveFieldClause,
  clauseStateFor,
  escapeQueryValue,
  isQueryableFieldName,
  setClausePolarity,
  toggleQueryClause,
  tokenizeQuery,
} from '../query-clauses';

describe('bleveFieldClause', () => {
  it('always quotes the value', () => {
    expect(bleveFieldClause('level', 'ERROR')).toBe('+level:"ERROR"');
    expect(bleveFieldClause('level', 'ERROR', '-')).toBe('-level:"ERROR"');
  });
  it('keeps spaces and colons inside the quotes', () => {
    expect(bleveFieldClause('message', 'connection timeout')).toBe('+message:"connection timeout"');
    expect(bleveFieldClause('url', '/api/v1:8080')).toBe('+url:"/api/v1:8080"');
  });
  it('escapes backslashes before quotes', () => {
    expect(escapeQueryValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeQueryValue('C:\\temp')).toBe('C:\\\\temp');
    expect(bleveFieldClause('path', 'a\\"b')).toBe('+path:"a\\\\\\"b"');
  });
});

describe('tokenizeQuery', () => {
  it('splits on whitespace outside quotes only', () => {
    expect(tokenizeQuery('+a:"x y"  "z w" bare')).toEqual(['+a:"x y"', '"z w"', 'bare']);
  });
  it('keeps escaped quotes inside a phrase', () => {
    expect(tokenizeQuery('+m:"say \\"hi\\" now" next')).toEqual(['+m:"say \\"hi\\" now"', 'next']);
  });
  it('returns no tokens for an empty query', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});

describe('toggleQueryClause', () => {
  it('adds to an empty query', () => {
    expect(toggleQueryClause('', '+level:"ERROR"')).toBe('+level:"ERROR"');
  });
  it('toggles off back to empty', () => {
    expect(toggleQueryClause('+level:"ERROR"', '+level:"ERROR"')).toBe('');
  });
  it('appends with a single space and removes exact matches only', () => {
    const q = toggleQueryClause('timeout', '+level:"ERROR"');
    expect(q).toBe('timeout +level:"ERROR"');
    expect(toggleQueryClause(q, '+level:"ERROR"')).toBe('timeout');
    expect(toggleQueryClause(q, '+level:"ERRO"')).toBe('timeout +level:"ERROR" +level:"ERRO"');
  });
  it('leaves an unrelated quoted phrase untouched', () => {
    const q = '"connection timeout" +service:"api"';
    expect(toggleQueryClause(q, '+level:"ERROR"')).toBe('"connection timeout" +service:"api" +level:"ERROR"');
    expect(toggleQueryClause(q, '+service:"api"')).toBe('"connection timeout"');
  });
  it('lets a + clause and its - twin coexist when toggled independently', () => {
    const q = toggleQueryClause('+level:"ERROR"', '-level:"ERROR"');
    expect(q).toBe('+level:"ERROR" -level:"ERROR"');
  });
});

describe('setClausePolarity', () => {
  it('filter then exclude replaces the polarity rather than stacking', () => {
    const a = setClausePolarity('', 'level', 'ERROR', '+');
    expect(a).toEqual({ query: '+level:"ERROR"', active: true });
    const b = setClausePolarity(a.query, 'level', 'ERROR', '-');
    expect(b).toEqual({ query: '-level:"ERROR"', active: true });
    const c = setClausePolarity(b.query, 'level', 'ERROR', '-');
    expect(c).toEqual({ query: '', active: false });
  });
  it('reports the current polarity', () => {
    expect(clauseStateFor('x +level:"ERROR"', 'level', 'ERROR')).toBe('+');
    expect(clauseStateFor('x -level:"ERROR"', 'level', 'ERROR')).toBe('-');
    expect(clauseStateFor('x', 'level', 'ERROR')).toBeNull();
  });
});

describe('isQueryableFieldName', () => {
  it('accepts dotted and underscored names, rejects dashes and colons', () => {
    expect(isQueryableFieldName('level')).toBe(true);
    expect(isQueryableFieldName('http.status')).toBe(true);
    expect(isQueryableFieldName('_src')).toBe(true);
    expect(isQueryableFieldName('request-id')).toBe(false);
    expect(isQueryableFieldName('a:b')).toBe(false);
    expect(isQueryableFieldName('')).toBe(false);
  });
});
