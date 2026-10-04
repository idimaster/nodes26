import { describe, expect, it } from 'vitest';
import { tokenize, TokenizeError } from '../src/index.js';

const kinds = (q: string) => tokenize(q).map((t) => `${t.type}:${t.value}`);

describe('tokenize', () => {
  it('splits words, punctuation, params, numbers, and strings', () => {
    expect(kinds("MATCH (n:Deal {code: $deal}) RETURN n.code, 'x'")).toEqual([
      'word:MATCH', 'punct:(', 'word:n', 'punct::', 'word:Deal', 'punct:{', 'word:code', 'punct::', 'param:deal',
      'punct:}', 'punct:)', 'word:RETURN', 'word:n', 'punct:.', 'word:code', 'punct:,', 'string:x',
    ]);
  });

  it('drops line and block comments', () => {
    expect(kinds('MATCH (n) // DELETE n\n/* DETACH */ RETURN n')).toEqual([
      'word:MATCH', 'punct:(', 'word:n', 'punct:)', 'word:RETURN', 'word:n',
    ]);
  });

  it('keeps keywords inside strings as strings, with escapes', () => {
    expect(kinds(String.raw`RETURN 'it\'s DELETE', "a \"b\" ; c"`)).toEqual([
      'word:RETURN', "string:it's DELETE", 'punct:,', 'string:a "b" ; c',
    ]);
  });

  it('unquotes backtick identifiers, including doubled backticks', () => {
    expect(kinds('MATCH (n:`Gate``Decision`) RETURN `n`')).toEqual([
      'word:MATCH', 'punct:(', 'word:n', 'punct::', 'quoted:Gate`Decision', 'punct:)', 'word:RETURN', 'quoted:n',
    ]);
  });

  it('reads ranges and multi-character operators', () => {
    expect(kinds('[*1..3]->(b)<-[:R]-(c) WHERE x <> 1 AND y IS :: INTEGER')).toEqual([
      'punct:[', 'punct:*', 'number:1', 'punct:..', 'number:3', 'punct:]', 'punct:->', 'punct:(', 'word:b', 'punct:)',
      'punct:<-', 'punct:[', 'punct::', 'word:R', 'punct:]', 'punct:-', 'punct:(', 'word:c', 'punct:)', 'word:WHERE',
      'word:x', 'punct:<>', 'number:1', 'word:AND', 'word:y', 'word:IS', 'punct:::', 'word:INTEGER',
    ]);
  });

  it('marks dynamic labels and calls on parameters', () => {
    expect(kinds('SET n:$($label)')).toEqual(['word:SET', 'word:n', 'punct::', 'dynamic:$(', 'punct:(', 'param:label', 'punct:)']);
    expect(kinds('MATCH (n:$any($ls))')).toContain('dynamic:$any(');
  });

  it('refuses unterminated strings, comments, and identifiers', () => {
    expect(() => tokenize("RETURN 'open")).toThrow(TokenizeError);
    expect(() => tokenize('RETURN 1 /* open')).toThrow(TokenizeError);
    expect(() => tokenize('MATCH (n:`open) RETURN n')).toThrow(TokenizeError);
  });
});
