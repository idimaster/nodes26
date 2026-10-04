import { describe, expect, it } from 'vitest';
import { validate, type GateRecord, type GuardContext } from '../src/index.js';

const gates: Record<string, GateRecord> = {
  'gd-ok': { deal_code: 'nimbus', iteration: 1, gate: 'commit', status: 'approved' },
  'gd-pending': { deal_code: 'nimbus', iteration: 1, gate: 'commit', status: 'pending' },
  'gd-select': { deal_code: 'nimbus', iteration: 1, gate: 'select', status: 'approved' },
  'gd-other-deal': { deal_code: 'tidewater', iteration: 1, gate: 'commit', status: 'approved' },
  'gd-other-iteration': { deal_code: 'nimbus', iteration: 2, gate: 'commit', status: 'approved' },
};

const lookups: string[] = [];
const ctx: GuardContext = {
  activeTerms: [
    { kind: 'label', name: 'DataResidencyRequirement', scope: 'nimbus' },
    { kind: 'relationship', name: 'CONSTRAINED_BY', scope: 'global' },
    { kind: 'label', name: 'TidewaterOnly', scope: 'tidewater' },
  ],
  lookupGate: async (id) => {
    lookups.push(id);
    return gates[id] ?? null;
  },
};

const allow = async (query: string, params: Record<string, unknown> = { deal: 'nimbus' }) => {
  const d = await validate(query, params, ctx);
  expect(d, d.allow ? '' : d.reason).toEqual({ allow: true });
};
const deny = async (rule: string, query: string, params: Record<string, unknown> = { deal: 'nimbus' }, reason?: RegExp) => {
  const d = await validate(query, params, ctx);
  expect(d.allow, `expected ${rule} to deny:\n${query}`).toBe(false);
  if (!d.allow) {
    expect(d.violations.map((v) => v.rule)).toContain(rule);
    if (reason) expect(d.reason).toMatch(reason);
  }
};

const READ_SEL = 'MATCH (s:Selection {deal_code: $deal}) RETURN s.uc AS uc';

describe('PARSE', () => {
  it('denies what it cannot tokenize', async () => {
    await deny('PARSE', "MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'open RETURN s");
  });
});

describe('G1: one statement', () => {
  it('allows a trailing semicolon', () => allow(`${READ_SEL};`));
  it('denies a second statement', () => deny('G1', `${READ_SEL}; MATCH (n:Deal) RETURN n`));
  it('ignores a semicolon inside a string', () => allow("MATCH (s:Selection {deal_code: $deal}) RETURN 'a;b' AS x"));
});

describe('G2: destructive and admin operations', () => {
  it.each([
    ['DELETE', 'MATCH (s:Selection {deal_code: $deal}) DELETE s RETURN 1'],
    ['DETACH', 'MATCH (s:Selection {deal_code: $deal}) DETACH DELETE s RETURN 1'],
    ['REMOVE', 'MATCH (s:Selection {deal_code: $deal}) REMOVE s.rationale RETURN s'],
    ['DROP', 'DROP CONSTRAINT selection_key RETURN 1'],
    ['FOREACH', 'MATCH (s:Selection {deal_code: $deal}) FOREACH (x IN [1] | SET s.rationale = "x") RETURN s'],
    ['LOAD CSV', "LOAD CSV FROM 'file:///x' AS row MERGE (s:Selection {deal_code: $deal, uc: row[0]}) RETURN s"],
    ['IN TRANSACTIONS', 'CALL () { MATCH (s:Selection {deal_code: $deal}) SET s.rationale = "x" } IN TRANSACTIONS RETURN 1'],
    ['CREATE INDEX', 'CREATE INDEX x FOR (n:Selection) ON (n.uc) RETURN 1'],
    ['CREATE CONSTRAINT', 'CREATE CONSTRAINT x FOR (n:Selection) REQUIRE n.uc IS UNIQUE RETURN 1'],
    ['ALTER', 'ALTER DATABASE neo4j SET ACCESS READ ONLY RETURN 1'],
    ['GRANT', 'GRANT ROLE admin TO neo4j RETURN 1'],
    ['USE', 'USE system MATCH (s:Selection {deal_code: $deal}) RETURN s'],
    ['dbms.', 'CALL dbms.components() YIELD name RETURN name'],
  ])('denies %s', (_k, q) => deny('G2', q));

  it('denies DELETE next to comments meant to hide it', () =>
    deny('G2', 'MATCH (s:Selection {deal_code: $deal}) /* harmless */ DETACH // really\n DELETE s RETURN 1'));
  it('allows the words inside string literals', () =>
    allow("MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'DELETE DROP; DETACH' RETURN s"));
  it('allows a property named like a keyword', () => allow('MATCH (s:Selection {deal_code: $deal}) RETURN s.delete AS d'));
});

describe('G3: procedures and APOC', () => {
  it('allows db.labels', () => allow('CALL db.labels() YIELD label RETURN label'));
  it('allows CALL {} and CALL (x) {} subqueries', async () => {
    await allow(
      'MATCH (s:Selection {deal_code: $deal}) CALL (s) { MATCH (c:Candidate {deal_code: $deal, uc: s.uc}) RETURN count(c) AS n } RETURN n',
    );
    await allow('CALL { MATCH (s:Selection {deal_code: $deal}) RETURN s } RETURN s.uc AS uc');
  });
  it('denies another procedure', () => deny('G3', 'CALL db.schema.visualization() YIELD nodes RETURN nodes'));
  it('denies apoc.merge.node, which would hide labels in params', () =>
    deny('G3', 'CALL apoc.merge.node($labels, {id: $id}) YIELD node RETURN node', { deal: 'nimbus', labels: ['GateDecision'], id: 'x' }));
  it('denies apoc functions', () =>
    deny('G3', 'MATCH (s:Selection {deal_code: $deal}) SET s.rationale = apoc.text.join(["a"], "") RETURN s'));
});

describe('G4: bounded patterns', () => {
  it('allows *1..10 and an exact *3', async () => {
    await allow('MATCH (a:Pattern)-[:REQUIRES*1..10]->(b:Pattern) RETURN b.id AS id');
    await allow('MATCH (a:Pattern)-[:REQUIRES*3]->(b:Pattern) RETURN b.id AS id');
  });
  it.each([
    ['*', 'MATCH (a:Pattern)-[:REQUIRES*]->(b:Pattern) RETURN b'],
    ['*..', 'MATCH (a:Pattern)-[*..]->(b:Pattern) RETURN b'],
    ['*2..', 'MATCH (a:Pattern)-[:REQUIRES*2..]->(b:Pattern) RETURN b'],
    ['*1..11', 'MATCH (a:Pattern)-[:REQUIRES*1..11]->(b:Pattern) RETURN b'],
    ['quantifier +', 'MATCH (a:Pattern)-[:REQUIRES]->+(b:Pattern) RETURN b'],
    ['quantifier {1,}', 'MATCH ((a:Pattern)-[:REQUIRES]->(b:Pattern)){1,} RETURN b'],
    ['quantifier {1,20}', 'MATCH (a:Pattern)-[:REQUIRES]->{1,20}(b:Pattern) RETURN b'],
  ])('denies %s', (_k, q) => deny('G4', q));
  it('allows a bounded quantifier and plain arithmetic', async () => {
    await allow('MATCH (a:Pattern)-[:REQUIRES]->{1,5}(b:Pattern) RETURN b.id AS id');
    await allow('MATCH (t:Task) RETURN t.weeks_e * 2 AS w, count(*) AS n');
  });
});

describe('G5: per-deal writes take $deal', () => {
  it('allows a per-deal write with $deal', () =>
    allow('MATCH (s:Selection {deal_code: $deal, uc: $uc}) SET s.rationale = $r RETURN s', { deal: 'nimbus', uc: 'x', r: 'y' }));
  it('denies a per-deal write without params.deal', () =>
    deny('G5', "MATCH (s:Selection {deal_code: 'nimbus'}) SET s.rationale = 'x' RETURN s", {}));
  it('denies a per-deal write that never references $deal', () =>
    deny('G5', "MATCH (s:Selection {deal_code: 'nimbus'}) SET s.rationale = 'x' RETURN s"));
  it('does not apply to reads or global labels', async () => {
    await allow("MATCH (s:Selection {deal_code: 'nimbus'}) RETURN s", {});
    await allow("MATCH (p:Pattern {id: 'x'}) SET p.note = 'y' RETURN p", {});
  });
});

describe('G6: only known labels and types', () => {
  it('denies an invented label, with an actionable reason', () =>
    deny('G6', 'MERGE (r:DataResidency {deal_code: $deal, id: $id}) RETURN r', { deal: 'nimbus', id: 'x' }, /propose_term/));
  it('denies an invented relationship type', () =>
    deny('G6', 'MATCH (a:Finding {deal_code: $deal}), (b:Source {deal_code: $deal}) MERGE (a)-[:CITES]->(b) RETURN a'));
  it('allows an active term scoped to this deal or global', async () => {
    await allow('MERGE (r:DataResidencyRequirement {deal_code: $deal, id: $id}) RETURN r', { deal: 'nimbus', id: 'x' });
    await allow(
      'MATCH (a:Finding {deal_code: $deal}), (b:DataResidencyRequirement {deal_code: $deal}) MERGE (a)-[:CONSTRAINED_BY]->(b) RETURN a',
    );
  });
  it("denies another deal's scoped term", () =>
    deny('G6', 'MERGE (r:TidewaterOnly {deal_code: $deal, id: $id}) RETURN r', { deal: 'nimbus', id: 'x' }));
  it('sees labels in backticks, label expressions, and WHERE predicates', async () => {
    await deny('G6', 'MATCH (n:`Invented`) RETURN n');
    await deny('G6', 'MATCH (n:Selection|Invented) RETURN n');
    await deny('G6', 'MATCH (n:Selection) WHERE n:Invented RETURN n');
  });
  it('treats map keys as keys, not labels', () =>
    allow("MATCH (s:Selection {deal_code: $deal, Invented: 1}) RETURN {Invented: s.uc, other: 'x'} AS m"));
  it.each([
    ['$(...)', 'MATCH (s:Selection {deal_code: $deal}) SET s:$($label) RETURN s'],
    ['$any(...)', 'MATCH (n:$any($labels)) RETURN n'],
  ])('denies dynamic labels %s', (_k, q) => deny('G6', q, { deal: 'nimbus', label: 'GateDecision', labels: ['GateDecision'] }));
});

describe('G7: reserved labels and the data around them', () => {
  it.each(['GateDecision', 'Feedback', 'Override', 'Actual', 'OntologyTerm'])('denies touching %s', (label) =>
    deny('G7', `MATCH (n:${label} {deal_code: $deal}) RETURN n`),
  );
  it('denies a reserved label in backticks or hidden in a comment-free disguise', async () => {
    await deny('G7', 'MATCH (n:`GateDecision`) RETURN n');
    await deny('G7', 'MATCH (s:Selection {deal_code: $deal}) SET s:GateDecision RETURN s');
  });
  it('denies an unlabeled node in a write query (it could be a reserved node)', () =>
    deny('G7', "MATCH (g) WHERE g.id = 'gd-1' SET g.status = 'approved' RETURN g", {}, /label/));
  it('allows a variable that was bound with a label earlier', () =>
    allow("MATCH (s:Selection {deal_code: $deal}) MATCH (s)-[:FOR]->(f:FramedUseCase) SET s.rationale = 'x' RETURN s"));
  it('allows anonymous nodes in read clauses of a write query', () =>
    allow(
      "MATCH (s:Selection {deal_code: $deal}) WHERE NOT EXISTS { (s)-[:HAS_TASK]->(:PlanTask)<-[:ON]-() } SET s.rationale = 'x' RETURN s",
    ));
  it('denies an anonymous node created by MERGE or CREATE', () =>
    deny('G7', 'MATCH (s:Selection {deal_code: $deal}) MERGE (s)-[:FOR]->() RETURN s'));
  it('denies writing a relationship type that belongs to reserved nodes', () =>
    deny('G7', 'MATCH (s:Selection {deal_code: $deal}), (t:Selection {deal_code: $deal}) MERGE (s)-[:RESOLVED_BY]->(t) RETURN s'));
  it.each(['nodes', 'relationships', 'startNode', 'endNode'])('denies %s() in a write query', (fn) =>
    deny(
      'G7',
      `MATCH p = (s:Selection {deal_code: $deal})-[:FOR*1..2]-(x:Selection) UNWIND ${fn}(p) AS n SET n.rationale = 'x' RETURN 1`,
    ),
  );
});

describe('G8: committed needs an approved commit gate', () => {
  const COMMIT = "MATCH (s:Selection {deal_code: $deal, iteration: $iteration}) SET s.status = 'committed' RETURN s";
  const p = (gate_id?: string, iteration = 1) => ({ deal: 'nimbus', iteration, ...(gate_id ? { gate_id } : {}) });

  it('allows it with an approved commit gate for this deal and iteration (one lookup)', async () => {
    lookups.length = 0;
    await allow(COMMIT, p('gd-ok'));
    expect(lookups).toEqual(['gd-ok']);
  });
  it.each([
    ['no gate_id', p()],
    ['unknown gate', p('gd-none')],
    ['pending gate', p('gd-pending')],
    ['select gate used for commit', p('gd-select')],
    ['gate of another deal', p('gd-other-deal')],
    ['gate of another iteration', p('gd-other-iteration')],
    ['missing iteration', { deal: 'nimbus', gate_id: 'gd-ok' }],
  ])('denies: %s', (_k, params) => deny('G8', COMMIT, params));

  it("denies 'committed' arriving through a parameter, even nested", async () => {
    await deny('G8', 'MATCH (s:Selection {deal_code: $deal}) SET s.rationale = $x RETURN s', { deal: 'nimbus', x: 'committed' });
    await deny('G8', 'MATCH (s:Selection {deal_code: $deal}) SET s.rationale = $m.a RETURN s', {
      deal: 'nimbus',
      m: { a: ['x', { b: 'COMMITTED' }] },
    });
  });
  it('denies status written as anything but a plain literal', async () => {
    await deny('G8', "MATCH (s:Selection {deal_code: $deal}) SET s.status = 'commit' + 'ted' RETURN s");
    await deny('G8', 'MATCH (s:Selection {deal_code: $deal}) SET s.status = $status RETURN s', { deal: 'nimbus', status: 'draft' });
    await deny('G8', "MERGE (s:Selection {deal_code: $deal, uc: 'u', status: toLower('X')}) RETURN s");
  });
  it('denies whole-map property assignment', async () => {
    await deny('G8', 'MATCH (s:Selection {deal_code: $deal}) SET s += $props RETURN s', { deal: 'nimbus', props: { status: 'committed' } });
    await deny('G8', 'MATCH (s:Selection {deal_code: $deal}) SET s = {uc: 1} RETURN s');
  });
  it('allows draft status as a literal', () =>
    allow("MERGE (s:Selection {deal_code: $deal, iteration: 1, uc: 'u'}) ON CREATE SET s.status = 'draft' RETURN s"));
});

describe('G9: ends with RETURN', () => {
  it('allows RETURN with modifiers', () => allow(`${READ_SEL} ORDER BY uc LIMIT 3`));
  it('denies no RETURN', () => deny('G9', "MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'x'"));
  it('denies a RETURN only inside a subquery', () =>
    deny('G9', "MATCH (s:Selection {deal_code: $deal}) CALL (s) { RETURN 1 AS one } SET s.rationale = 'x'"));
  it('denies a write after the last RETURN... via UNION-free trailing clause', () =>
    deny('G9', "MATCH (s:Selection {deal_code: $deal}) RETURN s SET s.rationale = 'x'"));
});

describe('the reason', () => {
  it('lists every violation with its rule', async () => {
    const d = await validate('MATCH (g:GateDecision)-[*]->(x) DETACH DELETE g', {}, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(new Set(d.violations.map((v) => v.rule))).toEqual(new Set(['G2', 'G4', 'G7', 'G9']));
      expect(d.reason.split('\n').length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('regressions: bypasses found in adversarial review', () => {
  const D = { deal: 'nimbus' };
  it.each([
    ['G7', 'IS label approves a gate', "MATCH (g IS GateDecision {id: 'gd-1'}) SET g.status = 'approved' RETURN g", {}],
    ['G7', 'IS label forges a gate', "CREATE (g IS GateDecision {id: 'x', status: 'approved'}) RETURN g", D],
    ['G6', 'IS label invents a label', "CREATE (g IS Bogus {id: 'x'}) RETURN g", D],
    ['G7', 'IS type writes a reserved relationship',
      'MATCH (a:Selection {deal_code: $deal}), (b:Selection {deal_code: $deal}) CREATE (a)-[r IS DECIDED_ON]->(b) RETURN r', D],
    ['G6', 'wildcard label', "MATCH (g:%) WHERE g.id = 'gd-1' SET g.status = 'approved' RETURN g", {}],
    ['G6', 'negated label', "MATCH (g:!Strategy) WHERE g.id = 'gd-1' SET g.status = 'approved' RETURN g", {}],
    ['G6', 'wildcard in a pattern comprehension',
      "MATCH (d:Deal {code: $deal}) WITH [(d)<-[:HAS_ITERATION]-(g:%) | g] AS gs UNWIND gs AS g SET g.status = 'approved' RETURN 1", D],
    ['G7', 'variable reused after WITH drops it',
      "MATCH (g:Deal {code: $deal}) WITH count(g) AS c MATCH (g) WHERE g.id = 'gd-1' SET g.status = 'approved' RETURN c", D],
    ['G7', 'variable labeled only inside EXISTS',
      "MATCH (s:Selection {deal_code: $deal}) WHERE EXISTS { MATCH (g:Deal) } MATCH (g) SET g.status = 'approved' RETURN 1", D],
    ['G7', 'old-style CALL {} does not see outer variables',
      "MATCH (g:Deal {code: $deal}) CALL { MATCH (g) SET g.status = 'approved' RETURN 1 AS one } RETURN one", D],
    ['G7', 'CALL (s) imports only s',
      'MATCH (s:Selection {deal_code: $deal}), (d:Deal {code: $deal}) CALL (s) { MATCH (d) SET d.x = 1 } RETURN 1', D],
    ['G7', 'UNWIND variables are unlabeled',
      "MATCH (s:Selection {deal_code: $deal}) WITH collect(s) AS xs UNWIND xs AS g SET g.status = 'draft' RETURN 1", D],
    ['G3', 'backticked apoc procedure',
      "CALL `apoc`.create.node(['GateDecision'], {id: 'x'}) YIELD node RETURN node", {}],
    ['G3', 'backticked apoc function', 'MATCH (d:Deal {code: $deal}) SET d.x = `apoc`.create.uuid() RETURN d', D],
    ['G3', 'backticked db procedure', "CALL `db`.`createLabel`('X') RETURN 1", {}],
    ['G8', 'WHERE inside a list comprehension in SET',
      "MATCH (s:Selection {deal_code: $deal}) SET s.a = [x IN [1] WHERE true | x], s.status = 'commit' + 'ted' RETURN s", D],
    ['G8', 'MATCH inside COUNT {} in SET',
      "MATCH (s:Selection {deal_code: $deal}) SET s.a = COUNT { MATCH (x:Deal) RETURN x }, s.status = 'commit' + 'ted' RETURN s", D],
    ['G8', 'map assignment after a list comprehension',
      "MATCH (s:Selection {deal_code: $deal}) SET s.a = [x IN [1] WHERE true | x], s += {status: 'commit' + 'ted'} RETURN s", D],
    ['G7', 'a relationship type named like a clause (ON)',
      "MATCH (d:Deal {code: $deal}) CREATE (d)-[:ON]->(s:Selection {deal_code: $deal, iteration: 1, uc: 'u', status: 'commit' + 'ted'}) RETURN s", D],
    ['G7', 'anonymous node created behind an ON relationship', 'MATCH (d:Deal {code: $deal}) CREATE (d)-[:ON]->() RETURN d', D],
    ['G7', 'dynamic property write', "MATCH (s:Selection {deal_code: $deal}) SET s['status'] = 'commit' + 'ted' RETURN s", D],
    ['G7', 'SET on an expression', "MATCH (s:Selection {deal_code: $deal}) SET (CASE WHEN true THEN s ELSE s END).rationale = 'x' RETURN s", D],
    ['G7', 'SET on an untyped relationship to an anonymous node',
      'MATCH (p:PlanTask {deal_code: $deal})-[r]-() SET r.weeks_actual = 99 RETURN r', D],
    ['G4', 'hexadecimal quantifier bound', 'MATCH ((a:Task)-[:DEPENDS_ON]->(b:Task)){1,0x7f} RETURN b', {}],
    ['G2', 'IN CONCURRENT TRANSACTIONS',
      "CALL () { MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'x' } IN CONCURRENT TRANSACTIONS RETURN 1", D],
    ['G2', 'RENAME ROLE', 'RENAME ROLE a TO b RETURN 1', {}],
  ] as const)('%s: %s', (rule, _name, query, params) => deny(rule, query, params));

  it.each([
    ['WITH alias carries the label', "MATCH (s:Selection {deal_code: $deal}) WITH s AS sel SET sel.rationale = 'x' RETURN sel"],
    ['WITH * carries labels', "MATCH (s:Selection {deal_code: $deal}) WITH * SET s.rationale = 'x' RETURN s"],
    ['CALL (s) imports a labeled variable',
      "MATCH (s:Selection {deal_code: $deal}) CALL (s) { SET s.rationale = 'x' } RETURN s.uc AS uc"],
    ['EXISTS sees the outer label',
      "MATCH (s:Selection {deal_code: $deal}) WHERE EXISTS { MATCH (s)-[:FOR]->(:FramedUseCase) } SET s.rationale = 'x' RETURN s"],
    ['typed, non-reserved relationship property',
      "MATCH (s:Selection {deal_code: $deal})-[r:FOR]->(f:FramedUseCase) SET r.note = 'x' RETURN r"],
    ['IS NOT NULL is not a label', "MATCH (s:Selection {deal_code: $deal}) WHERE s.uc IS NOT NULL SET s.rationale = 'x' RETURN s"],
    ['IS with a known label', "MATCH (s IS Selection {deal_code: $deal}) SET s.rationale = 'x' RETURN s"],
    ['adding an active label', 'MATCH (f:Finding {deal_code: $deal}) SET f:DataResidencyRequirement RETURN f'],
  ])('allows: %s', (_name, query) => allow(query));
});

describe('regressions: found while fixing the review', () => {
  it('UNION resets variable scope', () =>
    deny(
      'G7',
      "MATCH (s:Selection {deal_code: $deal}) RETURN s.uc AS uc UNION MATCH (s) SET s.rationale = 'x' RETURN s.uc AS uc",
    ));
  it("decodes unicode escapes, so 'commi\\u0074ted' needs a gate", () =>
    deny('G8', String.raw`MATCH (s:Selection {deal_code: $deal}) SET s.status = 'committed' RETURN s`));
  it('refuses a malformed unicode escape', () =>
    deny('PARSE', String.raw`MATCH (s:Selection {deal_code: $deal}) SET s.rationale = '\u00' RETURN s`));
});

describe('regressions: second adversarial review', () => {
  const D = { deal: 'nimbus' };
  it.each([
    ['G2', 'NEXT starts a new query part',
      "MATCH (s:Selection {deal_code: $deal}) RETURN count(s) AS z NEXT MATCH (s) WHERE s.gate = 'commit' SET s.status = 'approved' RETURN s"],
    ['G2', 'CYPHER 25 prefix', "CYPHER 25 MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'x' RETURN s"],
    ['G2', 'LET', "MATCH (s:Selection {deal_code: $deal}) LET x = s SET x.rationale = 'x' RETURN s"],
    ['G2', 'FILTER', "MATCH (s:Selection {deal_code: $deal}) FILTER s.uc = 'x' SET s.rationale = 'x' RETURN s"],
    ['G2', 'conditional query branches',
      "WHEN $deal = 'x' THEN { MATCH (s:Selection {deal_code: $deal}) SET s.n = 1 RETURN s.n AS n } ELSE { MATCH (s) SET s.status = 'approved' RETURN s.n AS n }"],
    ['G2', 'GQL INSERT', "INSERT (r:Roadmap {deal_code: 'HRB', version: 9, status: 'commit' + 'ted'}) RETURN r"],
    ['G2', 'INSERT a reserved edge',
      'MATCH (s:Selection {deal_code: $deal})<-[:ON]-(f) MATCH (t:PlanTask {deal_code: $deal}) INSERT (f)-[:RESOLVED_BY]->(t) RETURN t'],
    ['G2', 'SHOW', 'SHOW PROCEDURES YIELD name RETURN name'],
    ['G2', 'EXPLAIN', "EXPLAIN MATCH (s:Selection {deal_code: $deal}) SET s.rationale = 'x' RETURN s"],
    ['G7', 'a variable named ON',
      "MATCH (s:Selection {deal_code: $deal}) WITH s, 'x' AS on SET s.note = on, s.status = 'commit' + 'ted' RETURN s"],
    ['G7', 'a variable named LIMIT', "MATCH (s:Selection {deal_code: $deal}) WITH s, 1 AS limit SET s.note = limit RETURN s"],
    ['G7', 'a variable named ON before CREATE',
      "WITH 'x' AS on CREATE (r:Roadmap {deal_code: $deal, version: 1, status: 'commit' + 'ted'}) RETURN r"],
    ['G4', 'unbounded quantifier after --', 'MATCH (s:Selection)--+(x:Pattern) RETURN count(*) AS n'],
    ['G4', 'unbounded quantifier after <--', 'MATCH (s:Selection)<--+(x:Pattern) RETURN count(*) AS n'],
    ['G4', 'unbounded {1,} after --', 'MATCH (s:Selection)--{1,}(x:Pattern) RETURN count(*) AS n'],
    ['G4', '* after --', 'MATCH (s:Selection)--*(x:Pattern) RETURN count(*) AS n'],
    ['G4', '+ before a closing brace',
      'MATCH (s:Selection) WHERE COUNT { (s) ((a:Task)-[:DEPENDS_ON]->(b:Task))+ } > 0 RETURN s'],
    ['G8', 'status as a string map key',
      "MERGE (s:Selection {deal_code: $deal, uc: 'u', 'status': 'commit' + 'ted'}) RETURN s"],
  ] as const)('%s: %s', (rule, _name, query) => deny(rule, query, D));

  it('allows arithmetic on parenthesized expressions', () =>
    allow('MATCH (s:Selection {deal_code: $deal}) SET s.w = (s.a) * (s.b) RETURN s.uc AS uc'));
  it('allows CASE … WHEN … THEN … ELSE … END in expressions', () =>
    allow("MATCH (s:Selection {deal_code: $deal}) SET s.rationale = CASE WHEN s.uc = 'x' THEN 'a' ELSE 'b' END RETURN s"));
  it('explains how to use a node returned from a subquery', () =>
    deny('G7', 'MATCH (i:Iteration {deal_code: $deal}) CALL (i) { MATCH (s:Selection)-[:IN_ITERATION]->(i) RETURN s } SET s.x = 1 RETURN s', D,
      /returned from a subquery/));
});

describe('regressions: third adversarial review', () => {
  const Q = { deal: 'quarry' };
  it.each([
    ['G7', 'a negated label test in WHERE does not label a node',
      "MATCH (g WHERE g.deal_code = $deal AND g.gate = 'commit') WHERE NOT (g:Strategy) SET g.status = 'approved' RETURN g.id"],
    ['G7', 'inline WHERE with a negated label test',
      "MATCH (g WHERE g.deal_code = $deal AND NOT (g:Strategy)) SET g.status = 'approved' RETURN g.id"],
    ['G7', 'MERGE onto a node bound only by an inline WHERE',
      'MATCH (s:Selection {deal_code: $deal}), (g WHERE g.deal_code = $deal AND NOT (g:Strategy)) MERGE (s)-[:SELECTS]->(g) RETURN s'],
    ['G2', 'path selector hides an unlabeled node',
      "MATCH ANY SHORTEST (g)-[:DECIDED_ON]->(i:Iteration {deal_code: $deal}) WHERE NOT (g:Strategy) SET g.status = 'approved' RETURN g"],
    ['G7', 'adding a label to a node bound by an inline WHERE',
      'MATCH (g WHERE g.deal_code = $deal AND NOT (g:Strategy)) SET g:Strategy RETURN g'],
    ['G2', 'match mode', "MATCH REPEATABLE ELEMENTS (s:Selection {deal_code: $deal})-[:FOR]->(f:FramedUseCase) SET s.rationale = 'x' RETURN s"],
  ] as const)('%s: %s', (rule, _name, query) => deny(rule, query, Q));

  it('a label test in WHERE on an already labeled node still works', () =>
    allow("MATCH (s:Selection {deal_code: $deal}) WHERE NOT (s:Strategy) SET s.rationale = 'x' RETURN s"));
  it('WITH *, a AS b carries the alias', () =>
    allow("MATCH (a:Selection {deal_code: $deal}) WITH *, a AS b SET b.rationale = 'x' RETURN b"));
  it('inline WHERE on a labeled node is fine', () =>
    allow("MATCH (s:Selection WHERE s.deal_code = $deal) SET s.rationale = 'x' RETURN s"));
});
