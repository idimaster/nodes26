import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validate } from '@planner/guard';
import { GateError, GateStore } from '@planner/gate';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T2.5: the gate server writes exactly the nodes DESIGN §4 specifies, and nothing else. */

let driver: Driver;
let store: GateStore;

const one = async (query: string, params: Record<string, unknown> = {}) =>
  (await driver.executeQuery(query, params)).records[0]?.toObject() ?? {};
const num = (v: unknown) => Number(v);

/** Every relationship type and count attached to a gate, its feedback, and its overrides. */
async function shape(gateId: string) {
  return one(
    `MATCH (g:GateDecision {id: $id})
     RETURN g.status AS status, g.by AS by, g.comment AS comment, g.at IS NOT NULL AS at,
            toFloat(COUNT { (g)-[:DECIDED_ON]->() }) AS decided_on,
            toFloat(COUNT { (g)-[:CREATED]->(:Override) }) AS overrides,
            toFloat(COUNT { (:Feedback)-[:FROM]->(g) }) AS feedback,
            COLLECT { MATCH (f:Feedback)-[:FROM]->(g) MATCH (f)-[:ON]->(s) RETURN labels(s)[0] + ':' + coalesce(s.uc, s.id, toString(s.n)) } AS feedback_on`,
    { id: gateId },
  );
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.executeQuery(
    `MATCH (d:Deal {code: 'nimbus'})
     CREATE (i:Iteration {deal_code: 'nimbus', n: 1, started_at: datetime(), status: 'draft'})
     CREATE (d)-[:HAS_ITERATION]->(i)
     CREATE (s1:Selection {deal_code: 'nimbus', iteration: 1, uc: 'ledger-data-sync', pattern: 'cdc-replication', fit_score: 85.3, rationale: 'x', status: 'draft'})
     CREATE (s2:Selection {deal_code: 'nimbus', iteration: 1, uc: 'reporting-consolidation', pattern: 'batch-etl-export', fit_score: 89.1, rationale: 'x', status: 'draft'})
     CREATE (c1:Candidate {deal_code: 'nimbus', iteration: 1, uc: 'ledger-data-sync', pattern: 'event-bus-bridge', fit_score: 84.4, band: 'recommend', signal_snapshot: '{}'})
     CREATE (c2:Candidate {deal_code: 'nimbus', iteration: 1, uc: 'ledger-data-sync', pattern: 'far-away', fit_score: 40, band: 'surface', signal_snapshot: '{}'})
     CREATE (c1)-[:ALTERNATIVE_TO]->(s1), (c2)-[:ALTERNATIVE_TO]->(s1)
     CREATE (s1)-[:IN_ITERATION]->(i), (s2)-[:IN_ITERATION]->(i)
     CREATE (:OntologyTerm {kind: 'label', name: 'DataResidencyRequirement', scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'label', name: 'RejectedThing', scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'label', name: 'lowercaseThing', scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'label', name: 'TidewaterTerm', scope: 'tidewater', status: 'proposed', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'label', name: 'StillProposed', scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1})
     RETURN 1`,
  );
  store = new GateStore(driver);
});

afterAll(async () => {
  await driver.executeQuery('DROP CONSTRAINT data_residency_requirement_key IF EXISTS');
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

const SELECTIONS = ['Selection:ledger-data-sync', 'Selection:reporting-consolidation'];
const request = (subject_ids = SELECTIONS, gate: 'select' | 'commit' | 'frame' | 'ontology_term' | 'ontology_promote' = 'select') =>
  store.requestGate({ deal: 'nimbus', iteration: 1, gate, subject_ids, summary: 'Two selections to review.' });

describe('request_approval writes a pending gate', () => {
  it('refuses an unknown subject and writes nothing', async () => {
    await expect(request(['Selection:no-such-uc'])).rejects.toThrow(/Selection:no-such-uc/);
    expect(num((await one("MATCH (g:GateDecision {deal_code: 'nimbus'}) RETURN count(g) AS n")).n)).toBe(0);
  });

  it('writes GateDecision {pending} with DECIDED_ON to each subject, with deterministic ids', async () => {
    const { gate_id } = await request();
    expect(gate_id).toBe('gd-nimbus-1-select-1');
    expect(await shape(gate_id)).toMatchObject({ status: 'pending', by: '', comment: '', decided_on: 2, overrides: 0, feedback: 0 });
    expect((await request()).gate_id).toBe('gd-nimbus-1-select-2');
    const result = await store.getResult(gate_id);
    expect(result).toEqual({ status: 'pending', gate_id, feedback_ids: [], overrides: [] });
  });
});

describe('decisions write exactly the specified nodes', () => {
  it('approve without a comment: status only', async () => {
    const { gate_id } = await request();
    const result = await store.decide(gate_id, { action: 'approve', comment: '', by: 'architect' });
    expect(result).toEqual({ status: 'approved', gate_id, feedback_ids: [], overrides: [] });
    expect(await shape(gate_id)).toMatchObject({ status: 'approved', by: 'architect', at: true, decided_on: 2, overrides: 0, feedback: 0 });
  });

  it('approve with prose: Feedback ON each subject and FROM the gate, no Override', async () => {
    const { gate_id } = await request();
    const result = await store.decide(gate_id, { action: 'approve', comment: 'Fine, but watch the ledger load.', by: 'architect' });
    expect(result).toEqual({ status: 'approved', gate_id, feedback_ids: [`fb-${gate_id}`], overrides: [] });
    const s = await shape(gate_id);
    expect(s).toMatchObject({ comment: 'Fine, but watch the ledger load.', feedback: 1, overrides: 0 });
    expect((s.feedback_on as string[]).sort()).toEqual(['Selection:ledger-data-sync', 'Selection:reporting-consolidation']);
    expect(await one(`MATCH (f:Feedback {id: $id}) RETURN f.status AS status, f.deal_code AS deal, f.text AS text`, { id: `fb-${gate_id}` })).toEqual({
      status: 'open',
      deal: 'nimbus',
      text: 'Fine, but watch the ledger load.',
    });
  });

  it('approve except: approved, Feedback, and an Override with CREATED and CONSTRAINS', async () => {
    const { gate_id } = await request();
    const result = await store.decide(gate_id, { action: 'approve_except', comment: 'except cdc-replication', by: 'architect' });
    expect(result).toEqual({
      status: 'approved',
      gate_id,
      feedback_ids: [`fb-${gate_id}`],
      overrides: [{ id: `ov-${gate_id}-1`, kind: 'exclude_pattern', subject: 'cdc-replication', value: '' }],
    });
    expect(
      await one(
        `MATCH (g:GateDecision {id: $gid})-[:CREATED]->(o:Override)-[:CONSTRAINS]->(p:Pattern)
         RETURN o.id AS id, o.active AS active, o.deal_code AS deal, p.id AS pattern`,
        { gid: gate_id },
      ),
    ).toEqual({ id: `ov-${gate_id}-1`, active: true, deal: 'nimbus', pattern: 'cdc-replication' });
  });

  it('approve except with nothing to except is refused, and the gate stays pending', async () => {
    const { gate_id } = await request();
    await expect(store.decide(gate_id, { action: 'approve_except', comment: 'hmm', by: 'architect' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(await shape(gate_id)).toMatchObject({ status: 'pending', feedback: 0, overrides: 0 });
  });

  it('reject: every grammar row becomes its Override; a directive has no CONSTRAINS', async () => {
    const { gate_id } = await request();
    const comment = [
      'This does not fit.',
      'remove cdc-replication',
      'except reporting-consolidation',
      'keep event-bus-bridge',
      'include ledger-data-sync',
      'use bridge for ledger-data-sync',
      'directive: Prefer what Harborline already runs.',
    ].join('\n');
    const result = await store.decide(gate_id, { action: 'reject', comment, by: 'architect' });
    expect(result.status).toBe('rejected');
    expect(result.overrides.map((o) => [o.kind, o.subject, o.value])).toEqual([
      ['exclude_pattern', 'cdc-replication', ''],
      ['exclude_use_case', 'reporting-consolidation', ''],
      ['pin_pattern', 'event-bus-bridge', ''],
      ['include_use_case', 'ledger-data-sync', ''],
      ['strategy_for', 'ledger-data-sync', 'bridge'],
      ['directive', '', 'Prefer what Harborline already runs.'],
    ]);
    const constrained = await one(
      `MATCH (:GateDecision {id: $gid})-[:CREATED]->(o:Override)
       OPTIONAL MATCH (o)-[:CONSTRAINS]->(t)
       RETURN collect(o.kind + '->' + coalesce(labels(t)[0] + ':' + t.id, 'none')) AS c`,
      { gid: gate_id },
    );
    expect((constrained.c as string[]).sort()).toEqual(
      [
        'directive->none',
        'exclude_pattern->Pattern:cdc-replication',
        'exclude_use_case->UseCase:reporting-consolidation',
        'include_use_case->UseCase:ledger-data-sync',
        'pin_pattern->Pattern:event-bus-bridge',
        'strategy_for->UseCase:ledger-data-sync',
      ].sort(),
    );
    expect(await shape(gate_id)).toMatchObject({ feedback: 1, overrides: 6 });
  });

  it('a decided gate cannot be decided again; an unknown gate is not found', async () => {
    const { gate_id } = await request();
    await store.decide(gate_id, { action: 'reject', comment: '', by: 'architect' });
    await expect(store.decide(gate_id, { action: 'approve', comment: '', by: 'architect' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.decide('gd-nope', { action: 'approve', comment: '', by: 'x' })).rejects.toBeInstanceOf(GateError);
    await expect(store.decide('gd-nope', { action: 'approve', comment: '', by: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ontology gates', () => {
  it('ontology_term approve: the term becomes active, APPROVED_BY the gate, with a (deal_code, id) constraint', async () => {
    const { gate_id } = await request(['OntologyTerm:label/DataResidencyRequirement'], 'ontology_term');
    await store.decide(gate_id, { action: 'approve', comment: 'Looks right.', by: 'architect' });
    expect(
      await one(
        `MATCH (t:OntologyTerm {kind: 'label', name: 'DataResidencyRequirement'})-[:APPROVED_BY]->(g:GateDecision {id: $gid})
         RETURN t.status AS status, toFloat(COUNT { (:Feedback)-[:ON]->(t) }) AS feedback_on_term`,
        { gid: gate_id },
      ),
    ).toEqual({ status: 'active', feedback_on_term: 0 });
    const c = await one(
      `SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties WHERE name = 'data_residency_requirement_key'
       RETURN labelsOrTypes, properties`,
    );
    expect(c).toEqual({ labelsOrTypes: ['DataResidencyRequirement'], properties: ['deal_code', 'id'] });
  });

  it('ontology_term reject: the term is rejected', async () => {
    const { gate_id } = await request(['OntologyTerm:label/RejectedThing'], 'ontology_term');
    await store.decide(gate_id, { action: 'reject', comment: '', by: 'architect' });
    expect(await one(`MATCH (t:OntologyTerm {name: 'RejectedThing'}) RETURN t.status AS s`)).toEqual({ s: 'rejected' });
  });

  it('ontology_promote approve: the term becomes global', async () => {
    const { gate_id } = await request(['OntologyTerm:label/DataResidencyRequirement'], 'ontology_promote');
    await store.decide(gate_id, { action: 'approve', comment: '', by: 'architect' });
    expect(await one(`MATCH (t:OntologyTerm {name: 'DataResidencyRequirement'}) RETURN t.scope AS s`)).toEqual({ s: 'global' });
  });
});

describe('resolve_feedback', () => {
  let feedbackId: string;
  beforeAll(async () => {
    const { gate_id } = await request();
    feedbackId = (await store.decide(gate_id, { action: 'reject', comment: 'Ledger sync is too slow.', by: 'architect' })).feedback_ids[0] as string;
  });

  it('refuses another deal, an unknown feedback id, and an unknown subject, and changes nothing', async () => {
    const base = { iteration: 1, resolved_by_ids: ['Selection:ledger-data-sync'] };
    await expect(store.resolveFeedback({ ...base, deal: 'tidewater', feedback_id: feedbackId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.resolveFeedback({ ...base, deal: 'nimbus', feedback_id: 'fb-nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      store.resolveFeedback({ deal: 'nimbus', iteration: 1, feedback_id: feedbackId, resolved_by_ids: ['Selection:no-such-uc'] }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await one(`MATCH (f:Feedback {id: $id}) RETURN f.status AS s, toFloat(COUNT { (f)-[:RESOLVED_BY]->() }) AS r`, { id: feedbackId })).toEqual({
      s: 'open',
      r: 0,
    });
  });

  it('writes RESOLVED_BY and resolves; a second time is a conflict', async () => {
    const out = await store.resolveFeedback({ deal: 'nimbus', iteration: 1, feedback_id: feedbackId, resolved_by_ids: ['Selection:ledger-data-sync'] });
    expect(out).toEqual({ feedback_id: feedbackId, status: 'resolved', resolved_by: ['Selection:ledger-data-sync'] });
    expect(
      await one(`MATCH (f:Feedback {id: $id})-[:RESOLVED_BY]->(s:Selection) RETURN f.status AS status, s.uc AS uc`, { id: feedbackId }),
    ).toEqual({ status: 'resolved', uc: 'ledger-data-sync' });
    await expect(
      store.resolveFeedback({ deal: 'nimbus', iteration: 1, feedback_id: feedbackId, resolved_by_ids: ['Selection:ledger-data-sync'] }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('listGates for the console', () => {
  it('shows pending gates with each selection, its score, and alternatives within 20 points', async () => {
    const { gate_id } = await request(['Selection:ledger-data-sync']);
    const gates = await store.listGates('pending');
    const g = gates.find((x) => x.id === gate_id);
    expect(g).toMatchObject({ id: gate_id, deal_code: 'nimbus', iteration: 1, gate: 'select', status: 'pending', summary: 'Two selections to review.' });
    expect(g?.subjects).toEqual([
      {
        ref: 'Selection:ledger-data-sync',
        label: 'Selection',
        title: 'ledger-data-sync → cdc-replication',
        fit_score: 85.3,
        alternatives: [{ pattern: 'event-bus-bridge', fit_score: 84.4 }],
      },
    ]);
  });
});

describe('agents cannot write what the gate server writes (G7)', () => {
  it.each([
    "MATCH (f:Feedback {deal_code: $deal}) SET f.status = 'resolved' RETURN f",
    "MATCH (g:GateDecision {deal_code: $deal}) SET g.status = 'approved' RETURN g",
    "CREATE (o:Override {id: 'x', deal_code: $deal, kind: 'pin_pattern', subject: 'p', value: '', active: true}) RETURN o",
  ])('%s', async (query) => {
    const d = await validate(query, { deal: 'nimbus' }, { activeTerms: [], lookupGate: async () => null });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.violations.map((v) => v.rule)).toContain('G7');
  });
});

describe('review fixes: concurrency, ontology safety, refusals', () => {
  it('two concurrent decisions on one gate: exactly one wins, the other is a conflict, and the gate is consistent', async () => {
    const { gate_id } = await request();
    const results = await Promise.allSettled([
      store.decide(gate_id, { action: 'approve', comment: 'remove cdc-replication', by: 'a' }),
      store.decide(gate_id, { action: 'reject', comment: '', by: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'conflict' });
    const s = await shape(gate_id);
    if (s.status === 'approved') expect(s).toMatchObject({ by: 'a', overrides: 1, feedback: 1 });
    else expect(s).toMatchObject({ status: 'rejected', by: 'b', overrides: 0, feedback: 0 });
  });

  it('concurrent requests get distinct gate ids', async () => {
    const ids = await Promise.all([request(), request(), request()]);
    expect(new Set(ids.map((x) => x.gate_id)).size).toBe(3);
  });

  it('refuses an invalid label before writing anything', async () => {
    const { gate_id } = await request(['OntologyTerm:label/lowercaseThing'], 'ontology_term');
    await expect(store.decide(gate_id, { action: 'approve', comment: '', by: 'a' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await shape(gate_id)).toMatchObject({ status: 'pending' });
    expect(await one(`MATCH (t:OntologyTerm {name: 'lowercaseThing'}) RETURN t.status AS s`)).toEqual({ s: 'proposed' });
  });

  it("does not resolve another deal's term, and does not promote a term that is not active", async () => {
    await expect(request(['OntologyTerm:label/TidewaterTerm'], 'ontology_term')).rejects.toMatchObject({ code: 'invalid' });
    const { gate_id } = await request(['OntologyTerm:label/StillProposed'], 'ontology_promote');
    await expect(store.decide(gate_id, { action: 'approve', comment: '', by: 'a' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await one(`MATCH (t:OntologyTerm {name: 'StillProposed'}) RETURN t.scope AS s`)).toEqual({ s: 'nimbus' });
  });

  it('checks the gate before the input: unknown is 404 and decided is 409, even for approve_except', async () => {
    await expect(store.decide('gd-nope', { action: 'approve_except', comment: 'hmm', by: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    const { gate_id } = await request();
    await store.decide(gate_id, { action: 'approve', comment: '', by: 'a' });
    await expect(store.decide(gate_id, { action: 'approve_except', comment: 'hmm', by: 'a' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('approve_except needs an exclusion; keep or a directive is not an exception', async () => {
    const { gate_id } = await request();
    await expect(store.decide(gate_id, { action: 'approve_except', comment: 'keep event-bus-bridge', by: 'a' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('approve with a grammar line writes its Override; an unknown id is Feedback only', async () => {
    const a = await request();
    expect((await store.decide(a.gate_id, { action: 'approve', comment: 'keep event-bus-bridge', by: 'a' })).overrides).toHaveLength(1);
    const b = await request();
    const r = await store.decide(b.gate_id, { action: 'approve', comment: 'remove no-such-pattern', by: 'a' });
    expect([r.feedback_ids.length, r.overrides.length]).toEqual([1, 0]);
  });

  it('resolve_feedback refuses a non-plan subject', async () => {
    const { gate_id } = await request();
    const fb = (await store.decide(gate_id, { action: 'reject', comment: 'no', by: 'a' })).feedback_ids[0] as string;
    await expect(
      store.resolveFeedback({ deal: 'nimbus', iteration: 1, feedback_id: fb, resolved_by_ids: ['OntologyTerm:label/RejectedThing'] }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
