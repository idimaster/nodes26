/**
 * A small Cypher tokenizer for the write guard. It is not a parser: it only has to be exact
 * about what is code and what is not (strings, comments, quoted identifiers), so that rules
 * never fire on a keyword inside a string and never miss one hidden in backticks.
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'param' | 'number' | 'punct' | 'dynamic';

export interface Token {
  type: TokenType;
  /** Words keep their spelling; quoted identifiers and strings are unescaped; params have no `$`. */
  value: string;
  /** Offset in the query, for error messages. */
  pos: number;
}

export class TokenizeError extends Error {
  constructor(message: string, readonly pos: number) {
    super(`${message} at offset ${pos}`);
    this.name = 'TokenizeError';
  }
}

const PUNCT = ['::', '..', '->', '<-', '<>', '<=', '>=', '=~', '+=', '(', ')', '[', ']', '{', '}', ':', ',', '.', ';',
  '|', '&', '!', '%', '*', '+', '-', '/', '^', '=', '<', '>'];

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = query.length;

  const readQuoted = (quote: string, start: number): string => {
    let out = '';
    let j = start + 1;
    for (;;) {
      if (j >= n) throw new TokenizeError(`unterminated ${quote === '`' ? 'quoted identifier' : 'string'}`, start);
      const c = query[j] as string;
      if (quote === '`') {
        if (c === '`') {
          if (query[j + 1] === '`') {
            out += '`';
            j += 2;
            continue;
          }
          i = j + 1;
          return out;
        }
      } else {
        if (c === '\\') {
          const next = query[j + 1];
          if (next === undefined) throw new TokenizeError('unterminated string', start);
          // Decode exactly as Neo4j does, so 'commi\u0074ted' is seen as 'committed'.
          const unicode = /^u([0-9a-fA-F]{4})|^U([0-9a-fA-F]{8})/.exec(query.slice(j + 1));
          if (unicode) {
            out += String.fromCodePoint(parseInt((unicode[1] ?? unicode[2]) as string, 16));
            j += 1 + unicode[0].length;
            continue;
          }
          if (next === 'u' || next === 'U') throw new TokenizeError('malformed unicode escape', j);
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
          out += simple[next] ?? next;
          j += 2;
          continue;
        }
        if (c === quote) {
          i = j + 1;
          return out;
        }
      }
      out += c;
      j += 1;
    }
  };

  while (i < n) {
    const c = query[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '/' && query[i + 1] === '/') {
      const end = query.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && query[i + 1] === '*') {
      const end = query.indexOf('*/', i + 2);
      if (end === -1) throw new TokenizeError('unterminated comment', i);
      i = end + 2;
    } else if (c === "'" || c === '"') {
      const pos = i;
      tokens.push({ type: 'string', value: readQuoted(c, i), pos });
    } else if (c === '`') {
      const pos = i;
      tokens.push({ type: 'quoted', value: readQuoted('`', i), pos });
    } else if (c === '$') {
      const pos = i;
      let name: string;
      if (query[i + 1] === '`') {
        name = readQuoted('`', i + 1);
      } else {
        let j = i + 1;
        while (j < n && isWord(query[j] as string)) j += 1;
        name = query.slice(i + 1, j);
        i = j;
      }
      // `$(...)`, `$any(...)`, `$all(...)`: dynamic labels or types. A parameter is never called.
      // The `(` stays a separate token so brackets still balance.
      if (query[i] === '(') {
        tokens.push({ type: 'dynamic', value: `$${name}(`, pos });
      } else {
        if (name === '') throw new TokenizeError('empty parameter name', pos);
        tokens.push({ type: 'param', value: name, pos });
      }
    } else if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?)/.exec(query.slice(i)) as RegExpExecArray;
      tokens.push({ type: 'number', value: m[0], pos: i });
      i += m[0].length;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWord(query[j] as string)) j += 1;
      tokens.push({ type: 'word', value: query.slice(i, j), pos: i });
      i = j;
    } else {
      const p = PUNCT.find((x) => query.startsWith(x, i));
      if (!p) throw new TokenizeError(`unexpected character ${JSON.stringify(c)}`, i);
      tokens.push({ type: 'punct', value: p, pos: i });
      i += p.length;
    }
  }
  return tokens;
}
