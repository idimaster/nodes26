import { cypherTemplate, templateNames, templateParams } from '@planner/engine';
import { ontology } from '@planner/ontology';
import { tokenize, TokenizeError, type Token } from './tokenize.js';

/**
 * The write guard (DESIGN §3). Every rule works on tokens: nothing inside a string or comment
 * can trigger a rule, and nothing in backticks can escape one.
 *
 * For writes, the guard checks what it positively understands rather than listing what is
 * forbidden: SET items have a fixed grammar, and every node a write can reach must have been
 * bound with a label in the current variable scope. When unsure, it denies.
 */

export interface Term {
  kind: 'label' | 'relationship';
  name: string;
  /** 'global' or a deal code. */
  scope: string;
}

export interface GateRecord {
  deal_code: string;
  iteration: number;
  gate: string;
  status: string;
}

export interface GuardContext {
  /** Active ontology terms for 'global' and the deal (the adapter reads them in one query). */
  activeTerms: Term[];
  /** One read query; only called when G8 is triggered. */
  lookupGate: (id: string) => Promise<GateRecord | null>;
}

export interface Violation {
  rule: 'PARSE' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';
  message: string;
}

export type Decision = { allow: true } | { allow: false; violations: Violation[]; reason: string };

const MAX_HOPS = 10;
const PROCEDURE_ALLOWLIST = new Set(['db.labels', 'db.relationshipTypes']);
const CLAUSES = new Set([
  'MATCH', 'OPTIONAL', 'MERGE', 'CREATE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'WITH', 'UNWIND', 'CALL', 'FOREACH',
  'LOAD', 'USE', 'WHERE', 'RETURN', 'ORDER', 'SKIP', 'LIMIT', 'UNION', 'ON', 'YIELD', 'FINISH', 'OFFSET',
]);
const WRITE_WORDS = new Set(['CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH', 'REMOVE']);
const G5_WRITE_WORDS = new Set(['CREATE', 'MERGE', 'SET']);
const G2_WORDS = new Set(['DELETE', 'DETACH', 'REMOVE', 'DROP', 'FOREACH', 'ALTER', 'GRANT', 'DENY', 'REVOKE', 'USE',
  'TERMINATE', 'START', 'STOP', 'RENAME', 'ENABLE', 'DEALLOCATE', 'REALLOCATE', 'DRYRUN', 'TRANSACTIONS']);
const SCHEMA_NOUNS = new Set(['INDEX', 'CONSTRAINT', 'DATABASE', 'ALIAS', 'USER', 'ROLE', 'COMPOSITE', 'SERVER']);
const PATH_FUNCTIONS = new Set(['NODES', 'RELATIONSHIPS', 'STARTNODE', 'ENDNODE']);
const BLOCK_OPENERS = new Set(['EXISTS', 'COUNT', 'COLLECT', 'CALL']);
const PATTERN_KEYWORDS = new Set(['MATCH', 'MERGE', 'CREATE', 'WHERE', 'AND', 'OR', 'XOR', 'NOT', 'OPTIONAL']);
const IS_NOT_A_LABEL = new Set(['NULL', 'NOT', 'TYPED', 'NORMALIZED', 'NFC', 'NFD', 'NFKC', 'NFKD']);
/** Clauses the guard does not model (Cypher 25 / GQL / admin). The agent never needs them, so they are denied. */
const UNSUPPORTED = new Set(['NEXT', 'LET', 'FILTER', 'INSERT', 'SHOW', 'FINISH', 'CYPHER', 'EXPLAIN', 'PROFILE',
  // path selectors and match modes: not needed for writes, and they hide pattern starts
  'SHORTEST', 'REPEATABLE', 'DIFFERENT', 'WALK', 'TRAIL', 'ACYCLIC']);
/** Variables may not be named like these: otherwise a keyword-position word could be a variable. */
const KEYWORDS = new Set([
  ...CLAUSES, ...G2_WORDS, ...UNSUPPORTED, 'AND', 'OR', 'XOR', 'NOT', 'IN', 'IS', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'BY', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING', 'STARTS', 'ENDS', 'CONTAINS',
  'EXISTS', 'COUNT', 'COLLECT', 'ALL', 'ANY', 'NONE', 'SINGLE', 'SHORTEST', 'CSV', 'FROM', 'HEADERS', 'FOR', 'TO', 'OF',
  'REQUIRE', 'UNIQUE', 'KEY', 'NODE', 'RELATIONSHIP', 'OPTIONAL', 'DROP', 'DETACH',
]);
const ARROWS = new Set(['-', '->', '<-']);
/** Properties derived from the catalog or computed by the scheduler: written only by a cypher template (DESIGN §3, G7). */
const DERIVED = new Set(['task_id', 'weeks_o', 'weeks_e', 'weeks_p', 'skill', 'earliest_start', 'wave', 'on_critical_path']);
/** Plan-structure relationships: created only by write_plan_tasks (the graph derives them from the catalog). */
const PLAN_STRUCTURE = new Set(['DEPENDS_ON', 'INSTANTIATES', 'HAS_TASK']);

type Kind = 'paren' | 'callscope' | 'rel' | 'list' | 'map' | 'block' | 'quant';

const upper = (t: Token | undefined) => (t?.type === 'word' ? t.value.toUpperCase() : undefined);
const isP = (t: Token | undefined, v: string) => t?.type === 'punct' && t.value === v;
const isName = (t: Token | undefined) => t?.type === 'word' || t?.type === 'quoted';

/** The token at j closes a relationship pattern: `->`, or `-` after `]`, `)`, `-` (the `--` shorthand), or `<-`. */
let endsRelationship: (j: number) => boolean = () => false;

function quantifierAt(tokens: Token[], i: number): { upper: number | null } | null {
  // `{` number? (`,` number?)? `}`
  let j = i + 1;
  const num = () => (tokens[j]?.type === 'number' ? Number((tokens[j++]?.value ?? '').replace(/_/g, '')) : null);
  const lo = num();
  let hi: number | null = lo;
  let comma = false;
  if (isP(tokens[j], ',')) {
    comma = true;
    j += 1;
    hi = num();
  }
  if (!isP(tokens[j], '}') || (lo === null && !comma)) return null;
  return { upper: comma ? hi : lo };
}

interface Label {
  name: string;
  index: number;
  isType: boolean;
  /** Index of the token that introduced it (`:` or `IS`). */
  intro: number;
}

/** Recursively finds a string in params that contains the needle (case-insensitive). */
function paramsMention(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(needle);
  if (Array.isArray(value)) return value.some((v) => paramsMention(v, needle));
  if (value && typeof value === 'object') return Object.values(value).some((v) => paramsMention(v, needle));
  return false;
}

const sameTokens = (a: Token[], b: Token[]) => a.length === b.length && a.every((t, i) => t.type === b[i]?.type && t.value === b[i]?.value);
let templateTokens: { name: ReturnType<typeof templateNames>[number]; destructive: boolean; tokens: Token[] }[] | undefined;
const templates = () =>
  (templateTokens ??= templateNames().map((name) => {
    const t = cypherTemplate(name);
    return { name, destructive: t.destructive, tokens: tokenize(t.query) };
  }));

/** The query is, token for token, one of the engine's cypher templates. */
const isTemplate = (tokens: Token[]) => templates().some((t) => sameTokens(t.tokens, tokens));

/** The G2 exception: the exact token sequence of a destructive template, with params that pass its schema. */
function destructiveTemplateMatch(tokens: Token[], params: Record<string, unknown>): boolean {
  for (const t of templates()) {
    const name = t.name;
    if (!t.destructive || !sameTokens(t.tokens, tokens)) continue;
    try {
      templateParams(name, params);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function validate(query: string, params: Record<string, unknown>, ctx: GuardContext): Promise<Decision> {
  const violations: Violation[] = [];
  const add = (rule: Violation['rule'], message: string) => {
    if (!violations.some((v) => v.rule === rule && v.message === message)) violations.push({ rule, message });
  };
  const decide = (): Decision =>
    violations.length === 0
      ? { allow: true }
      : { allow: false, violations, reason: violations.map((v) => `${v.rule}: ${v.message}`).join('\n') };

  let tokens: Token[];
  try {
    tokens = tokenize(query);
  } catch (e) {
    add('PARSE', `${e instanceof TokenizeError ? e.message : String(e)}; the guard denies what it cannot read`);
    return decide();
  }

  endsRelationship = (j: number) => {
    const t = tokens[j];
    const before = tokens[j - 1];
    return isP(t, '->') || (isP(t, '-') && (isP(before, ']') || isP(before, ')') || isP(before, '-') || isP(before, '<-')));
  };

  // ---- Brackets: kind of each bracket, depth, and matching pairs.
  const inner: (Kind | undefined)[] = [];
  const depth: number[] = [];
  const closing = new Map<number, number>();
  const kindAt = new Map<number, Kind>();
  {
    const stack: { kind: Kind; index: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as Token;
      const prev = tokens[i - 1];
      inner.push(stack.at(-1)?.kind);
      depth.push(stack.length);
      if (t.type === 'punct' && ['(', '[', '{'].includes(t.value)) {
        let kind: Kind;
        if (t.value === '(') kind = upper(prev) === 'CALL' ? 'callscope' : 'paren';
        else if (t.value === '[') kind = prev?.type === 'punct' && ARROWS.has(prev.value) ? 'rel' : 'list';
        else if (upper(prev) && BLOCK_OPENERS.has(upper(prev) as string) && !isP(tokens[i - 2], '.')) kind = 'block';
        else if (isP(prev, ')') && [...closing].some(([o, c]) => c === i - 1 && kindAt.get(o) === 'callscope')) kind = 'block';
        else if ((isP(prev, ')') || endsRelationship(i - 1)) && quantifierAt(tokens, i))
          kind = 'quant';
        else kind = 'map';
        stack.push({ kind, index: i });
        kindAt.set(i, kind);
      } else if (t.type === 'punct' && [')', ']', '}'].includes(t.value)) {
        const open = stack.pop();
        const expected = { ')': '(', ']': '[', '}': '{' }[t.value];
        if (!open || tokens[open.index]?.value !== expected) {
          add('PARSE', `unbalanced brackets at offset ${t.pos}`);
          return decide();
        }
        closing.set(open.index, i);
      }
    }
    if (stack.length > 0) {
      add('PARSE', 'unbalanced brackets: something is never closed');
      return decide();
    }
  }

  // ---- Labels and relationship types, introduced by `:` or `IS`. Map keys are neither.
  const isKeyColon = (i: number) =>
    inner[i] === 'map' && ['word', 'quoted', 'string'].includes(tokens[i - 1]?.type ?? '') && (isP(tokens[i - 2], '{') || isP(tokens[i - 2], ','));
  const labels: Label[] = [];
  const labelToken = new Set<number>();
  let dynamic = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const colon = isP(t, ':') && !isKeyColon(i);
    const isIntro =
      upper(t) === 'IS' &&
      !isP(tokens[i - 1], '.') &&
      ((isName(next) && !IS_NOT_A_LABEL.has(upper(next) ?? '')) || isP(next, '%') || isP(next, '!') || isP(next, '(') || next?.type === 'dynamic');
    if (!colon && !isIntro) continue;
    if (isIntro) labelToken.add(i);
    const isType = inner[i] === 'rel';
    let j = i + 1;
    let local = 0;
    let expectName = true;
    for (;;) {
      const x = tokens[j];
      if (!x) break;
      if (expectName && isName(x)) {
        labels.push({ name: x.value, index: j, isType, intro: i });
        labelToken.add(j);
        expectName = false;
      } else if (expectName && x.type === 'dynamic') {
        dynamic += 1;
        break;
      } else if (expectName && isP(x, '(')) local += 1;
      else if (expectName && (isP(x, '%') || isP(x, '!'))) {
        add('G6', `label wildcards (%) and negation (!) are not allowed; name the label`);
        if (isP(x, '%')) expectName = false;
      } else if (!expectName && x.type === 'punct' && ['|', '&', ':'].includes(x.value)) expectName = true;
      else if (!expectName && isP(x, ')') && local > 0) local -= 1;
      else break;
      j += 1;
    }
  }
  for (const t of tokens) if (t.type === 'dynamic') dynamic += 1;

  // ---- Keywords: words that are not property names, labels, or map keys.
  const keyword = tokens.map(
    (t, i) => t.type === 'word' && !isP(tokens[i - 1], '.') && !labelToken.has(i) && !(isP(tokens[i + 1], ':') && isKeyColon(i + 1)),
  );
  const kw = (i: number) => (keyword[i] ? upper(tokens[i]) : undefined);
  const isClauseAt = (i: number) => CLAUSES.has(kw(i) ?? '');

  // ---- Current clause at each token, scoped by brackets (a WHERE inside [x IN … WHERE …] stays inside).
  const clause: (string | undefined)[] = [];
  {
    const stack: (string | undefined)[] = [undefined];
    tokens.forEach((t, i) => {
      if (isClauseAt(i)) stack[stack.length - 1] = kw(i);
      clause.push(stack.at(-1));
      if (t.type === 'punct' && ['(', '[', '{'].includes(t.value)) stack.push(stack.at(-1));
      if (t.type === 'punct' && [')', ']', '}'].includes(t.value)) stack.pop();
    });
  }

  const deal = typeof params.deal === 'string' && params.deal !== '' ? params.deal : undefined;
  const words = new Set(tokens.map((_, i) => kw(i)).filter((w): w is string => w !== undefined));
  const isWrite = [...WRITE_WORDS].some((w) => words.has(w));

  // G1: one statement
  tokens.forEach((t, i) => {
    if (isP(t, ';') && i !== tokens.length - 1) add('G1', 'more than one statement; send one statement per call');
  });

  // G2: destructive and admin operations
  if (!destructiveTemplateMatch(tokens, params)) {
    tokens.forEach((t, i) => {
      const w = kw(i);
      if (w && G2_WORDS.has(w)) {
        add('G2', w === 'TRANSACTIONS' ? 'CALL … IN TRANSACTIONS is not allowed' : `${w} is not allowed for the agent (DELETE only via the replace_selection template)`);
      }
      if (w === 'LOAD' && upper(tokens[i + 1]) === 'CSV') add('G2', 'LOAD CSV is not allowed');
      if (w === 'CREATE') {
        for (let j = i + 1; j <= i + 3 && tokens[j]?.type === 'word'; j++) {
          if (SCHEMA_NOUNS.has(upper(tokens[j]) as string)) add('G2', `CREATE ${upper(tokens[j])} (schema or admin) is not allowed`);
        }
      }
      if (isName(t) && t.value.toLowerCase() === 'dbms' && isP(tokens[i + 1], '.') && !isP(tokens[i - 1], '.')) add('G2', 'dbms.* is not allowed');
    });
  }

  // G2 (always): clauses the guard does not model, and conditional queries
  {
    let caseDepth = 0;
    tokens.forEach((_, i) => {
      const w = kw(i);
      if (!w) return;
      if (UNSUPPORTED.has(w)) add('G2', `${w} is not supported by the guard; write plain MATCH / MERGE / SET … RETURN`);
      if ((w === 'ANY' || w === 'ALL') && (kw(i - 1) === 'MATCH' || isP(tokens[i - 1], ',')) && ['MATCH', 'MERGE', 'CREATE'].includes(clause[i] ?? '')) {
        add('G2', `path selector ${w} is not supported by the guard`);
      }
      if (w === 'CASE') caseDepth += 1;
      else if (w === 'END' && caseDepth > 0) caseDepth -= 1;
      else if ((w === 'WHEN' || w === 'THEN' || w === 'ELSE') && caseDepth === 0) {
        add('G2', 'conditional queries (WHEN … THEN … ELSE outside CASE) are not supported by the guard');
      }
    });
  }

  // G7 (always): variables named like keywords would make keyword detection ambiguous
  tokens.forEach((t, i) => {
    if (!isName(t) || labelToken.has(i)) return;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const introduces =
      (keyword[i - 1] && upper(prev) === 'AS') ||
      (isP(prev, '(') && kindAt.get(i - 1) === 'paren' && (isP(next, ':') || isP(next, ')') || isP(next, '{') || labelToken.has(i + 1))) ||
      (isP(prev, '[') && kindAt.get(i - 1) === 'rel' && !isP(next, '.')) ||
      (isP(prev, '[') && kindAt.get(i - 1) === 'list' && upper(next) === 'IN') ||
      (isP(next, '=') && isP(tokens[i + 2], '(')) ||
      (clause[i] === 'YIELD' && (kw(i - 1) === 'YIELD' || isP(prev, ',')));
    if (introduces && KEYWORDS.has(t.value.toUpperCase())) {
      add('G7', `variable \`${t.value}\` is named like a Cypher keyword; rename it`);
    }
  });

  // G3: procedures, and APOC/GDS functions (backticks do not hide a namespace)
  tokens.forEach((t, i) => {
    if (kw(i) === 'CALL' && isName(tokens[i + 1])) {
      let name = tokens[i + 1]?.value ?? '';
      let j = i + 2;
      while (isP(tokens[j], '.') && isName(tokens[j + 1])) {
        name += `.${tokens[j + 1]?.value}`;
        j += 2;
      }
      if (!PROCEDURE_ALLOWLIST.has(name)) add('G3', `procedure ${name} is not allowed (allowed: ${[...PROCEDURE_ALLOWLIST].join(', ')})`);
    }
    const ns = isName(t) ? t.value.toLowerCase() : '';
    if ((ns === 'apoc' || ns === 'gds') && isP(tokens[i + 1], '.') && !isP(tokens[i - 1], '.')) {
      add('G3', `${ns}.* is not allowed; use plain Cypher (randomUUID() for ids)`);
    }
  });

  // G4: bounded patterns
  tokens.forEach((t, i) => {
    if (isP(t, '*') && inner[i] === 'rel') {
      let j = i + 1;
      const n = (k: number) => Number((tokens[k]?.value ?? '').replace(/_/g, ''));
      const lo = tokens[j]?.type === 'number' ? n(j++) : null;
      let hi: number | null;
      if (isP(tokens[j], '..')) {
        j += 1;
        hi = tokens[j]?.type === 'number' ? n(j) : null;
      } else hi = lo;
      if (hi === null || Number.isNaN(hi)) add('G4', `variable-length pattern without an upper bound; write *1..${MAX_HOPS} or less`);
      else if (hi > MAX_HOPS) add('G4', `variable-length upper bound ${hi} is above ${MAX_HOPS}`);
    }
    if (isP(t, '{') && kindAt.get(i) === 'quant') {
      const q = quantifierAt(tokens, i);
      if (q?.upper === null || q?.upper === undefined || Number.isNaN(q.upper)) {
        add('G4', `quantified path without an upper bound; write {1,${MAX_HOPS}} or less`);
      } else if (q.upper > MAX_HOPS) add('G4', `quantified path upper bound ${q.upper} is above ${MAX_HOPS}`);
    }
    if ((isP(t, '+') || isP(t, '*')) && inner[i] !== 'rel') {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const afterArrow = endsRelationship(i - 1);
      // A group is a pattern (not arithmetic) when it is empty, a single name, or holds a label or an arrow.
      const open = [...closing].find(([, c]) => c === i - 1)?.[0];
      const content = open === undefined ? [] : tokens.slice(open + 1, i - 1);
      const groupIsPattern =
        open !== undefined &&
        (content.length === 0 ||
          (content.length === 1 && isName(content[0])) ||
          labels.some((l) => l.index > open && l.index < i - 1) ||
          content.some((x) => x.type === 'punct' && ['->', '<-', '-'].includes(x.value) && isP(tokens[tokens.indexOf(x) - 1], ')')));
      const afterGroup =
        isP(prev, ')') &&
        groupIsPattern &&
        (next === undefined ||
          (next.type === 'punct' && ['(', '-', '<-', '->', ',', '}', ')', '|', ']'].includes(next.value)) ||
          isClauseAt(i + 1));
      if (afterArrow || afterGroup) {
        add('G4', `'${t.value}' after a pattern is an unbounded quantified path; use {1,${MAX_HOPS}} (if it is arithmetic, assign it with WITH first)`);
      }
    }
  });

  // ---- Ontology views
  const activeFor = (kind: Term['kind']) =>
    ctx.activeTerms.filter((x) => x.kind === kind && (x.scope === 'global' || x.scope === deal)).map((x) => x.name);
  const knownLabels = new Set([...ontology.labels.map((l) => l.name), ...activeFor('label')]);
  const knownTypes = new Set([...ontology.relationships.map((r) => r.type), ...activeFor('relationship')]);
  const reserved = new Set(ontology.labels.filter((l) => l.reserved).map((l) => l.name));
  const perDeal = new Set([
    ...ontology.labels.filter((l) => l.perDeal).map((l) => l.name),
    ...ctx.activeTerms.filter((x) => x.kind === 'label' && x.scope !== 'global').map((x) => x.name),
  ]);
  const reservedTypes = new Set(
    ontology.relationships
      .filter((r) => r.endpoints.some((e) => [...e.from, ...e.to].some((l) => reserved.has(l))))
      .map((r) => r.type),
  );

  // G5: per-deal writes take $deal
  const perDealUsed = labels.filter((l) => !l.isType && perDeal.has(l.name)).map((l) => l.name);
  if ([...G5_WRITE_WORDS].some((w) => words.has(w)) && perDealUsed.length > 0) {
    if (!deal) add('G5', `the query writes per-deal data (${[...new Set(perDealUsed)].join(', ')}) but params.deal is missing`);
    if (!tokens.some((t) => t.type === 'param' && t.value === 'deal')) {
      add('G5', 'the query writes per-deal data but never uses $deal; scope every per-deal match with deal_code: $deal');
    }
  }

  // G6: only known labels and types
  for (const l of labels) {
    if (!(l.isType ? knownTypes : knownLabels).has(l.name)) {
      add(
        'G6',
        `${l.isType ? 'relationship type' : 'label'} \`${l.name}\` is not in the ontology or an active term for global or deal ${deal ?? '(none)'}; use an existing one (get_ontology) or propose it with propose_term`,
      );
    }
  }
  if (dynamic > 0) add('G6', 'dynamic labels or types ($(…), $any(…), $all(…)) are not allowed; write the label literally');

  // G7: reserved labels anywhere
  for (const l of labels) {
    if (!l.isType && reserved.has(l.name)) add('G7', `label ${l.name} is reserved; only the gate server, ontology server, and loaders write it`);
  }

  // G7 + G8 for writes: scopes, node patterns, relationship variables, SET grammar
  const trustedTemplate = isWrite && isTemplate(tokens);
  const derivedMessage = (p: string) =>
    `${p} is a derived property (from the catalog or the scheduler); only write_plan_tasks and planner-graph schedule_plan write it`;
  if (isWrite) {
    tokens.forEach((t, i) => {
      if (kw(i) && PATH_FUNCTIONS.has(kw(i) as string) && isP(tokens[i + 1], '(')) {
        add('G7', `${t.value}() is not allowed in a write query (it can reach nodes the guard cannot see)`);
      }
    });
    for (const l of labels) {
      if (l.isType && PLAN_STRUCTURE.has(l.name) && ['MERGE', 'CREATE'].includes(clause[l.index] ?? '') && !isTemplate(tokens)) {
        add('G7', `${l.name} is plan structure; only the write_plan_tasks template creates it, from the catalog`);
      }
      if (l.isType && reservedTypes.has(l.name) && ['MERGE', 'CREATE'].includes(clause[l.index] ?? '')) {
        add('G7', `relationship type ${l.name} connects reserved nodes; only the gate and ontology servers write it`);
      }
    }

    interface Scope {
      nodes: Set<string>;
      rels: Set<string>;
      depth: number;
      closeAt: number;
    }
    // Names a CALL subquery returns: not tracked as labeled, but worth a precise message.
    const returnedBySubquery = new Set<string>();
    tokens.forEach((t, i) => {
      if (kw(i) === 'RETURN' && (depth[i] as number) > 0) {
        for (let j = i + 1; j < tokens.length && (depth[j] as number) >= (depth[i] as number); j++) {
          if (isName(tokens[j]) && (isP(tokens[j + 1], ',') || isP(tokens[j + 1], '}') || upper(tokens[j - 1]) === 'AS')) {
            returnedBySubquery.add(tokens[j]?.value ?? '');
          }
        }
      }
    });
    const hint = (name: string) =>
      returnedBySubquery.has(name) ? ' (variables returned from a subquery are not tracked; MATCH it again with its label)' : '';
    const scopes: Scope[] = [{ nodes: new Set(), rels: new Set(), depth: 0, closeAt: tokens.length }];
    const cur = () => scopes.at(-1) as Scope;
    const callscopeOpenBefore = (i: number) => [...closing].find(([o, c]) => c === i - 1 && kindAt.get(o) === 'callscope')?.[0];

    // End of a clause's item list that starts after index i (same depth, next clause keyword or the enclosing close).
    const listEnd = (i: number) => {
      const d = depth[i] as number;
      let j = i + 1;
      while (j < tokens.length && (depth[j] as number) >= d && !(depth[j] === d && isClauseAt(j))) j += 1;
      return j;
    };
    const splitItems = (from: number, to: number, d: number) => {
      const items: [number, number][] = [];
      let s = from;
      for (let j = from; j < to; j++) {
        if (isP(tokens[j], ',') && depth[j] === d) {
          items.push([s, j]);
          s = j + 1;
        }
      }
      if (s < to) items.push([s, to]);
      return items;
    };

    for (let i = 0; i < tokens.length; i++) {
      while (scopes.length > 1 && cur().closeAt === i) scopes.pop();
      const t = tokens[i] as Token;
      const w = kw(i);

      // New variable scopes
      if (isP(t, '{') && kindAt.get(i) === 'block') {
        const open = callscopeOpenBefore(i);
        let child: Scope;
        if (open !== undefined) {
          const names = tokens.slice(open + 1, i - 1).filter(isName).map((x) => x.value);
          const all = tokens.slice(open + 1, i - 1).some((x) => isP(x, '*'));
          child = {
            nodes: new Set([...cur().nodes].filter((n) => all || names.includes(n))),
            rels: new Set([...cur().rels].filter((n) => all || names.includes(n))),
            depth: depth[i] as number,
            closeAt: closing.get(i) as number,
          };
        } else if (upper(tokens[i - 1]) === 'CALL') {
          child = { nodes: new Set(), rels: new Set(), depth: depth[i] as number, closeAt: closing.get(i) as number };
        } else {
          child = { nodes: new Set(cur().nodes), rels: new Set(cur().rels), depth: depth[i] as number, closeAt: closing.get(i) as number };
        }
        scopes.push(child);
        continue;
      }
      if (isP(t, '[') && kindAt.get(i) === 'list') {
        const child: Scope = { nodes: new Set(cur().nodes), rels: new Set(cur().rels), depth: depth[i] as number, closeAt: closing.get(i) as number };
        if (isName(tokens[i + 1]) && upper(tokens[i + 2]) === 'IN') {
          child.nodes.delete(tokens[i + 1]?.value ?? '');
          child.rels.delete(tokens[i + 1]?.value ?? '');
        }
        scopes.push(child);
        continue;
      }

      // WITH projections decide what stays bound, and with which label status
      if (w === 'WITH') {
        const end = listEnd(i);
        let from = i + 1;
        if (upper(tokens[from]) === 'DISTINCT') from += 1;
        const nodes = new Set<string>();
        const rels = new Set<string>();
        let all = false;
        for (const [s, e] of splitItems(from, end, depth[i] as number)) {
          const item = tokens.slice(s, e);
          if (item.length === 1 && isP(item[0], '*')) all = true;
          const source = item[0]?.value ?? '';
          const target = item.length === 1 && isName(item[0]) ? source : item.length === 3 && isName(item[0]) && upper(item[1]) === 'AS' ? item[2]?.value : undefined;
          if (target === undefined) continue;
          if (cur().nodes.has(source)) nodes.add(target);
          if (cur().rels.has(source)) rels.add(target);
        }
        if (all) {
          for (const n of nodes) cur().nodes.add(n);
          for (const r of rels) cur().rels.add(r);
        } else {
          cur().nodes = nodes;
          cur().rels = rels;
        }
        continue;
      }
      // UNION starts a new query part: nothing stays bound
      if (w === 'UNION' && depth[i] === cur().depth + (scopes.length > 1 ? 1 : 0)) {
        cur().nodes = new Set();
        cur().rels = new Set();
        continue;
      }
      // UNWIND … AS x, and YIELD names, bind values the guard cannot see the label of
      if (w === 'UNWIND' || w === 'YIELD') {
        const end = listEnd(i);
        for (let j = i + 1; j < end; j++) {
          if (isName(tokens[j]) && (w === 'YIELD' || upper(tokens[j - 1]) === 'AS')) {
            cur().nodes.delete(tokens[j]?.value ?? '');
            cur().rels.delete(tokens[j]?.value ?? '');
          }
        }
      }

      // Relationship variables: only a single, explicit, non-reserved type makes them writable
      if (isP(t, '[') && kindAt.get(i) === 'rel' && isName(tokens[i + 1]) && !labelToken.has(i + 1)) {
        const name = tokens[i + 1]?.value ?? '';
        const end = closing.get(i) as number;
        const types = labels.filter((l) => l.isType && l.index > i && l.index < end);
        const alternatives = tokens.slice(i, end).some((x) => isP(x, '|'));
        if (types.length === 1 && !alternatives && !reservedTypes.has(types[0]?.name ?? '')) cur().rels.add(name);
        else cur().rels.delete(name);
      }

      // Node patterns bind only in pattern clauses; in WHERE and expressions, (v:Label) is a label test
      if (isP(t, '(') && kindAt.get(i) === 'paren' && ['MATCH', 'OPTIONAL', 'MERGE', 'CREATE'].includes(clause[i] ?? '')) {
        const prev = tokens[i - 1];
        const isCall = (prev?.type === 'word' && keyword[i - 1] && !PATTERN_KEYWORDS.has(upper(prev) as string)) || prev?.type === 'quoted' || prev?.type === 'dynamic';
        if (!isCall) {
          const end = closing.get(i) as number;
          const v = tokens[i + 1];
          const hasVar = isName(v) && !labelToken.has(i + 1);
          const after = tokens[hasVar ? i + 2 : i + 1];
          const labeled = isP(after, ':') || (hasVar ? labelToken.has(i + 2) : labelToken.has(i + 1));
          const simple = isP(after, ')') || isP(after, '{') || labeled || upper(after) === 'WHERE';
          const prevArrow = prev?.type === 'punct' && ARROWS.has(prev.value);
          const nextArrow = tokens[end + 1]?.type === 'punct' && ARROWS.has(tokens[end + 1]?.value ?? '');
          const patternStart =
            prevArrow ||
            nextArrow ||
            !hasVar ||
            labeled ||
            isP(after, '{') ||
            upper(after) === 'WHERE' ||
            (keyword[i - 1] && PATTERN_KEYWORDS.has(upper(prev) as string)) ||
            (isP(prev, ',') && ['MATCH', 'MERGE', 'CREATE', 'OPTIONAL'].includes(clause[i] ?? '')) ||
            isP(prev, '=') ||
            (isP(prev, '{') && kindAt.get(i - 1) === 'block') ||
            (isP(prev, '[') && kindAt.get(i - 1) === 'list');
          if (simple && patternStart) {
            const name = hasVar ? (v as Token).value : undefined;
            if (labeled) {
              if (name) cur().nodes.add(name);
            } else if (name && !cur().nodes.has(name)) {
              add('G7', `node (${name}) has no label in this scope of a write query; label it in the pattern (e.g. (${name}:Selection …)) so the guard can check it${hint(name)}`);
            } else if (!name && ['MERGE', 'CREATE'].includes(clause[i] ?? '')) {
              add('G7', 'an anonymous, unlabeled node would be created; give it a label');
            }
          }
        }
      }

      // SET items: only `var.prop = value` (var bound with a label, or a typed relationship) or `var:Label`
      if (w === 'SET') {
        const end = listEnd(i);
        for (const [s, e] of splitItems(i + 1, end, depth[i] as number)) {
          const [a, b, c, d] = [tokens[s], tokens[s + 1], tokens[s + 2], tokens[s + 3]];
          const target = a?.value ?? '';
          if (!isName(a)) {
            add('G7', 'SET may only assign var.property = value or add a label (var:Label)');
          } else if (isP(b, '.') && isName(c) && isP(d, '=')) {
            if (DERIVED.has((c?.value ?? '').toLowerCase()) && !trustedTemplate) add('G7', derivedMessage(c?.value ?? ''));
            if (!cur().nodes.has(target) && !cur().rels.has(target)) {
              add('G7', `cannot SET properties of ${target}: it is not a node bound with a label (or a relationship with one non-reserved type) in this scope${hint(target)}`);
            }
            if ((c?.value ?? '').toLowerCase() === 'status' && !(e - (s + 4) === 1 && tokens[s + 4]?.type === 'string')) {
              add('G8', "status may only be written as a plain string literal (e.g. s.status = 'draft')");
            }
          } else if (isP(b, ':') || labelToken.has(s + 1)) {
            if (!cur().nodes.has(target)) add('G7', `cannot add a label to ${target}: it is not a node bound with a label in this scope`);
          } else if (isP(b, '=') || isP(b, '+=')) {
            add('G8', `property-map assignment to ${target} is not allowed; set each property (n.prop = …)`);
          } else {
            add('G7', `unsupported SET item starting at ${target}; use var.property = value`);
          }
        }
      }

      // derived properties inside a MERGE/CREATE property map
      if ((isName(t) || t.type === 'string') && DERIVED.has(t.value.toLowerCase()) && isKeyColon(i + 1) &&
          ['MERGE', 'CREATE'].includes(clause[i] ?? '') && !trustedTemplate) {
        add('G7', derivedMessage(t.value));
      }
      // status inside a MERGE/CREATE property map: a plain literal only
      if ((isName(t) || t.type === 'string') && t.value.toLowerCase() === 'status' && isKeyColon(i + 1) && ['MERGE', 'CREATE'].includes(clause[i] ?? '')) {
        const value = tokens[i + 2];
        const after = tokens[i + 3];
        if (!(value?.type === 'string' && (isP(after, ',') || isP(after, '}')))) {
          add('G8', "status may only be written as a plain string literal (e.g. {status: 'draft'})");
        }
      }
    }
  }

  // G8: 'committed' needs an approved commit gate for this deal and iteration. A hand-written write is checked
  // in its params too (a value can reach status, e.g. via substring($x, …)). An exact template is not: none
  // routes a param into a status, so free text such as a rationale may say "committed" (a live-run false positive).
  const mentionsCommitted =
    tokens.some((t) => t.type === 'string' && t.value.toLowerCase().includes('committed')) ||
    (!isTemplate(tokens) && paramsMention(params, 'committed'));
  if (mentionsCommitted) {
    const gateId = params.gate_id;
    const iteration = params.iteration;
    if (typeof gateId !== 'string' || gateId === '') add('G8', "the query can set 'committed', which needs params.gate_id of an approved commit gate");
    else if (!Number.isInteger(iteration)) add('G8', "the query can set 'committed', which needs params.iteration (an integer)");
    else {
      const gate = await ctx.lookupGate(gateId);
      if (!gate) add('G8', `gate ${gateId} does not exist`);
      else if (gate.gate !== 'commit') add('G8', `gate ${gateId} is a ${gate.gate} gate, not a commit gate`);
      else if (gate.status !== 'approved') add('G8', `gate ${gateId} is ${gate.status}, not approved`);
      else if (gate.deal_code !== deal) add('G8', `gate ${gateId} belongs to deal ${gate.deal_code}, not ${deal ?? '(none)'}`);
      else if (gate.iteration !== iteration) add('G8', `gate ${gateId} is for iteration ${gate.iteration}, not ${String(iteration)}`);
    }
  }

  // G9: the statement ends with RETURN
  const top = tokens.map((_, i) => i).filter((i) => depth[i] === 0 && keyword[i]);
  const lastReturn = top.filter((i) => upper(tokens[i]) === 'RETURN').at(-1);
  if (lastReturn === undefined) add('G9', 'the query has no RETURN; end every write with RETURN (e.g. RETURN count(*) AS written)');
  else {
    const trailing = top.filter(
      (i) =>
        i > lastReturn &&
        ['MATCH', 'OPTIONAL', 'MERGE', 'CREATE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'WITH', 'UNWIND', 'CALL', 'FOREACH', 'LOAD', 'USE'].includes(
          upper(tokens[i]) as string,
        ),
    );
    if (trailing.length > 0) add('G9', `a ${upper(tokens[trailing[0] as number])} clause follows the last RETURN; RETURN must come last`);
  }

  return decide();
}
