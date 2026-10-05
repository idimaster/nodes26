import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { runValidators, VALIDATOR_FILES, type ValidatorResult } from '../../graph/validate.js';

/** T3.1: each validator FAILs on its planted fixture, PASSes on a clean plan, and an empty plan is "nothing checked". */

const DEAL = 'nimbus';
let driver: Driver;

const run = async (name: TemplateName, params: Record<string, unknown>) => {
  const { records } = await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params));
  return records.map((r) => r.toObject());
};

interface Pick {
  uc: string;
  pattern: string;
  score: number;
  findings: string[];
  alternatives?: [string, number][];
}

/** A draft plan for one iteration, written through the same templates the agent uses. */
async function plan(iteration: number, picks: Pick[]) {
  await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await run('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: picks.map((p) => ({ use_case_id: p.uc, framing_rationale: `Framed from ${p.findings.join(', ')}.`, finding_ids: p.findings })),
  });
  await run('write_candidates', {
    deal: DEAL,
    iteration,
    rows: picks.flatMap((p) => [
      { uc: p.uc, pattern: p.pattern, fit_score: p.score, band: 'recommend', signal_snapshot: '{}' },
      ...(p.alternatives ?? []).map(([pattern, score]) => ({ uc: p.uc, pattern, fit_score: score, band: 'surface', signal_snapshot: '{}' })),
    ]),
  });
  await run('write_selections', {
    deal: DEAL,
    iteration,
    rows: picks.map((p) => ({ uc: p.uc, pattern: p.pattern, fit_score: p.score, rationale: 'Top pick.' })),
  });
  await run('write_plan_tasks', { deal: DEAL, iteration });
}

const byCheck = (results: ValidatorResult[]) => Object.fromEntries(results.map((r) => [r.check, r]));

/** Every witness_eid resolves to the node whose id is the witness at the same position. */
async function eidsResolve(r: ValidatorResult) {
  for (const v of r.violations) {
    expect(v.witness_eids).toHaveLength(v.witness.length);
    const { records } = await driver.executeQuery(
      'UNWIND $eids AS eid MATCH (n) WHERE elementId(n) = eid RETURN coalesce(n.id, n.uc) AS id',
      { eids: v.witness_eids },
    );
    expect(records.map((x) => x.get('id'))).toEqual(v.witness);
  }
}

const CLEAN: Pick[] = [
  { uc: 'user-provisioning', pattern: 'scim-provisioning', score: 72.3, findings: ['f-no-scim'], alternatives: [['identity-cutover', 60]] },
  { uc: 'identity-federation-trust', pattern: 'idp-trust-establishment', score: 70, findings: ['f-no-scim'], alternatives: [['saml-federation', 62]] },
  { uc: 'ledger-data-sync', pattern: 'event-bus-bridge', score: 84.4, findings: ['f-ledger-sync'], alternatives: [['cdc-replication', 85.3]] },
];

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await run('classify_findings', { deal: DEAL, rows: [{ id: 'f-no-scim', classified_as: 'gap' }] });
});

afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('the validator set', () => {
  it('has one file per DESIGN §5.1 check, run in order', () => {
    expect(VALIDATOR_FILES.map((f) => f.check)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V6b', 'V7']);
  });
});

describe('a clean plan', () => {
  it('passes every check, and returns exactly one row per check', async () => {
    await plan(1, CLEAN);
    const results = await runValidators(DEAL, 1, { driver });
    expect(results.map((r) => [r.check, r.verdict])).toEqual([
      ['V1', 'PASS'], ['V2', 'PASS'], ['V3', 'PASS'], ['V4', 'PASS'], ['V5', 'PASS'], ['V6', 'PASS'], ['V6b', 'PASS'], ['V7', 'PASS'],
    ]);
    const r = byCheck(results);
    expect(r.V1?.examined).toBe(3);
    expect(r.V3?.examined).toBe(9); // 3 tasks each for scim-provisioning, idp-trust-establishment, event-bus-bridge
    expect(r.V6?.examined).toBe(6);
    expect(r.V7).toMatchObject({ examined: 29, coverage: expect.closeTo(27 / 29, 5) });
    for (const x of results) expect(x.violations.length === 0 || x.check === 'V7').toBe(true);
  });
});

describe('planted fixtures', () => {
  it('V1: a selected pattern REQUIRES an unselected one (P1)', async () => {
    await plan(2, [CLEAN[0] as Pick]);
    const v1 = byCheck(await runValidators(DEAL, 2, { driver })).V1 as ValidatorResult;
    expect(v1.verdict).toBe('FAIL');
    expect(v1.violations.map((v) => v.witness)).toEqual([['scim-provisioning', 'idp-trust-establishment']]);
    await eidsResolve(v1);
  });

  it('V2: two selected patterns CONFLICT (P2)', async () => {
    await plan(3, [
      { uc: 'ledger-data-sync', pattern: 'cdc-replication', score: 85.3, findings: ['f-ledger-sync'], alternatives: [['event-bus-bridge', 84.4]] },
      { uc: 'reporting-consolidation', pattern: 'batch-etl-export', score: 89.1, findings: ['f-reporting'], alternatives: [['cdc-replication', 82.7]] },
    ]);
    const v2 = byCheck(await runValidators(DEAL, 3, { driver })).V2 as ValidatorResult;
    expect(v2.verdict).toBe('FAIL');
    expect(v2.violations.map((v) => v.witness)).toEqual([['batch-etl-export', 'cdc-replication']]);
    expect(v2.violations[0]?.detail).toMatch(/reporting-consolidation selects batch-etl-export, which CONFLICTS with cdc-replication selected for ledger-data-sync/);
    await eidsResolve(v2);
  });

  it('V3: PlanTasks depend on each other in a cycle (P5), as the engine reports it', async () => {
    await plan(4, [{ uc: 'container-platform-migration', pattern: 'container-replatform-fastpath', score: 81.7, findings: ['f-vm-hosting'], alternatives: [['container-replatform', 70]] }]);
    const v3 = byCheck(await runValidators(DEAL, 4, { driver })).V3 as ValidatorResult;
    expect(v3.verdict).toBe('FAIL');
    const p = 'container-platform-migration:container-replatform-fastpath.';
    expect(v3.violations.map((v) => v.witness)).toEqual([[`${p}cluster-onboarding`, `${p}deploy-manifests`, `${p}image-build`, `${p}cluster-onboarding`]]);
    await eidsResolve(v3);
  });

  it('V4: a critical gap is not framed into a selected use case', async () => {
    await plan(5, [CLEAN[2] as Pick]);
    const v4 = byCheck(await runValidators(DEAL, 5, { driver })).V4 as ValidatorResult;
    expect(v4.verdict).toBe('FAIL');
    expect(v4.violations.map((v) => v.witness)).toEqual([['f-no-scim']]);
    await eidsResolve(v4);
  });

  it('V4: exact provenance only, so the right use case framed from a different finding does not count (gotcha 07b)', async () => {
    await plan(6, [{ ...(CLEAN[0] as Pick), findings: ['f-weak-mfa'] }, { ...(CLEAN[1] as Pick), findings: ['f-weak-mfa'] }]);
    const v4 = byCheck(await runValidators(DEAL, 6, { driver })).V4 as ValidatorResult;
    expect(v4.verdict).toBe('FAIL');
    expect(v4.violations.map((v) => v.witness)).toEqual([['f-no-scim']]);
  });

  it('V5: a Selection uses a pattern an active Override excludes (P4)', async () => {
    await plan(7, CLEAN);
    // Written as the gate server writes it (agents never write Override).
    await driver.executeQuery(
      `CREATE (:Override {id: 'ov-test-1', deal_code: $deal, kind: 'exclude_pattern', subject: 'event-bus-bridge', value: '', active: true})`,
      { deal: DEAL },
    );
    try {
      const v5 = byCheck(await runValidators(DEAL, 7, { driver })).V5 as ValidatorResult;
      expect(v5.verdict).toBe('FAIL');
      expect(v5.violations.map((v) => v.witness)).toEqual([['event-bus-bridge', 'ov-test-1']]);
      await eidsResolve(v5);
      await driver.executeQuery(`MATCH (o:Override {id: 'ov-test-1'}) SET o.active = false`);
      expect(byCheck(await runValidators(DEAL, 7, { driver })).V5?.verdict).toBe('PASS');
    } finally {
      await driver.executeQuery(`MATCH (o:Override {id: 'ov-test-1'}) DETACH DELETE o`);
    }
  });

  it('V6: a Selection without a fit_score and a framing without a rationale', async () => {
    await plan(8, CLEAN);
    await driver.executeQuery(
      `MATCH (s:Selection {deal_code: $deal, iteration: 8, uc: 'ledger-data-sync'}) SET s.fit_score = null
       WITH 1 AS x
       MATCH (fu:FramedUseCase {deal_code: $deal, iteration: 8, id: 'user-provisioning'}) SET fu.framing_rationale = '  '`,
      { deal: DEAL },
    );
    const v6 = byCheck(await runValidators(DEAL, 8, { driver })).V6 as ValidatorResult;
    expect(v6.verdict).toBe('FAIL');
    expect(v6.violations.map((v) => [v.witness, v.detail])).toEqual([
      [['user-provisioning'], 'FramedUseCase user-provisioning has no framing_rationale'],
      [['ledger-data-sync'], 'Selection ledger-data-sync has no fit_score'],
    ]);
    await eidsResolve(v6);
  });

  it('V6b: no alternative within 20 points is a WARN, not a FAIL', async () => {
    await plan(9, [{ ...(CLEAN[2] as Pick), alternatives: [['cdc-replication', 40]] }]);
    const v6b = byCheck(await runValidators(DEAL, 9, { driver })).V6b as ValidatorResult;
    expect(v6b.verdict).toBe('WARN');
    expect(v6b.violations.map((v) => v.witness)).toEqual([['ledger-data-sync']]);
  });

  it('V7: fails when coverage is below the floor', async () => {
    const v7 = byCheck(await runValidators(DEAL, 1, { driver, floor: 0.95 })).V7 as ValidatorResult;
    expect(v7.verdict).toBe('FAIL');
    expect(v7.violations.map((v) => v.witness).sort()).toEqual([['bulk-migration'], ['container-replatform-fastpath']]);
  });
});

describe('nothing to check is a failure, never a pass (gotcha 07a)', () => {
  it('an iteration without a plan', async () => {
    const results = await runValidators(DEAL, 99, { driver });
    expect(results.filter((r) => r.check !== 'V7').map((r) => [r.check, r.examined, r.verdict])).toEqual([
      ['V1', 0, 'FAIL: nothing checked'],
      ['V2', 0, 'FAIL: nothing checked'],
      ['V3', 0, 'FAIL: nothing checked'],
      ['V4', 0, 'FAIL: nothing checked'],
      ['V5', 0, 'FAIL: nothing checked'],
      ['V6', 0, 'FAIL: nothing checked'],
      ['V6b', 0, 'FAIL: nothing checked'],
    ]);
  });

  it('an empty graph, including the catalog for V7', async () => {
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    const results = await runValidators(DEAL, 1, { driver });
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.verdict === 'FAIL: nothing checked' && r.examined === 0)).toBe(true);
  });
});

describe('review fixes', () => {
  beforeAll(async () => {
    // The previous block ends with an empty graph.
    await loadAll(driver);
    await run('classify_findings', { deal: DEAL, rows: [{ id: 'f-no-scim', classified_as: 'gap' }] });
  });

  it('V1: an unselected intermediate is reported with each missing pattern on its path', async () => {
    await plan(20, [{ uc: 'access-reviews', pattern: 'access-review-automation', score: 70, findings: ['f-no-scim'], alternatives: [] }]);
    const v1 = byCheck(await runValidators(DEAL, 20, { driver, checks: ['V1'] })).V1 as ValidatorResult;
    expect(v1.violations.map((v) => v.witness)).toEqual([
      ['access-review-automation', 'scim-provisioning', 'idp-trust-establishment'],
      ['access-review-automation', 'scim-provisioning'],
    ]);
  });

  it('V2: the CONFLICTS edge counts in both directions', async () => {
    // Stored as identity-cutover -[:CONFLICTS]-> saml-federation; P2 (above) covers the reverse.
    await plan(21, [
      { uc: 'workforce-sso', pattern: 'saml-federation', score: 70, findings: ['f-no-scim'], alternatives: [] },
      { uc: 'user-provisioning', pattern: 'identity-cutover', score: 60, findings: ['f-no-scim'], alternatives: [] },
    ]);
    const v2 = byCheck(await runValidators(DEAL, 21, { driver, checks: ['V2'] })).V2 as ValidatorResult;
    expect(v2.violations.map((v) => v.witness)).toEqual([['identity-cutover', 'saml-federation']]);
  });

  it('V3: two cycles through one task give two simple witnesses, nothing more', async () => {
    await run('create_iteration', { deal: DEAL, n: 22, started_at: '2026-10-05T09:00:00Z' });
    await driver.executeQuery(
      `MATCH (i:Iteration {deal_code: $deal, n: 22})
       UNWIND ['x:a', 'x:b', 'x:c'] AS id
       CREATE (t:PlanTask {deal_code: $deal, iteration: 22, id: id, task_id: 't', weeks_o: 1, weeks_e: 1, weeks_p: 1, skill: 'ops', status: 'draft'})
       CREATE (t)-[:IN_ITERATION]->(i)
       WITH collect(t) AS ts
       WITH ts[0] AS a, ts[1] AS b, ts[2] AS c
       CREATE (a)-[:DEPENDS_ON]->(b), (b)-[:DEPENDS_ON]->(a), (a)-[:DEPENDS_ON]->(c), (c)-[:DEPENDS_ON]->(a)
       RETURN 1`,
      { deal: DEAL },
    );
    const v3 = byCheck(await runValidators(DEAL, 22, { driver, checks: ['V3'] })).V3 as ValidatorResult;
    expect(v3.violations.map((v) => v.witness)).toEqual([
      ['x:a', 'x:b', 'x:a'],
      ['x:a', 'x:c', 'x:a'],
    ]);
  });

  it('V4: a gap classified as something else is not a gap', async () => {
    await plan(23, [CLEAN[2] as Pick]);
    await run('classify_findings', { deal: DEAL, rows: [{ id: 'f-no-scim', classified_as: 'risk' }] });
    try {
      expect(byCheck(await runValidators(DEAL, 23, { driver, checks: ['V4'] })).V4?.verdict).toBe('PASS');
    } finally {
      await run('classify_findings', { deal: DEAL, rows: [{ id: 'f-no-scim', classified_as: 'gap' }] });
    }
  });

  it("V5: another deal's Override, or another kind, does not count", async () => {
    await plan(24, CLEAN);
    await driver.executeQuery(
      `CREATE (:Override {id: 'ov-x-1', deal_code: 'tidewater', kind: 'exclude_pattern', subject: 'event-bus-bridge', value: '', active: true})
       CREATE (:Override {id: 'ov-x-2', deal_code: $deal, kind: 'pin_pattern', subject: 'event-bus-bridge', value: '', active: true})`,
      { deal: DEAL },
    );
    try {
      expect(byCheck(await runValidators(DEAL, 24, { driver, checks: ['V5'] })).V5?.verdict).toBe('PASS');
    } finally {
      await driver.executeQuery(`MATCH (o:Override) WHERE o.id IN ['ov-x-1', 'ov-x-2'] DETACH DELETE o`);
    }
  });

  it('V6: a Selection without a SELECTS edge is an audit failure', async () => {
    await plan(25, CLEAN);
    await driver.executeQuery(
      `MATCH (:Selection {deal_code: $deal, iteration: 25, uc: 'ledger-data-sync'})-[r:SELECTS]->() DELETE r`,
      { deal: DEAL },
    );
    const v6 = byCheck(await runValidators(DEAL, 25, { driver, checks: ['V6'] })).V6 as ValidatorResult;
    expect(v6.violations.map((v) => v.detail)).toEqual(['Selection ledger-data-sync selects no pattern']);
  });

  it('V6b: an alternative far above the selection is not a near-miss (abs)', async () => {
    await plan(26, [{ ...(CLEAN[2] as Pick), score: 30, alternatives: [['cdc-replication', 85]] }]);
    expect(byCheck(await runValidators(DEAL, 26, { driver, checks: ['V6b'] })).V6b?.verdict).toBe('WARN');
  });

  it('V7: a missing floor fails instead of passing', async () => {
    const { records } = await driver.executeQuery(
      (await import('../../graph/validate.js')).VALIDATOR_FILES.find((v) => v.check === 'V7')?.query ?? '',
      { floor: null },
    );
    expect(records[0]?.get('verdict')).toBe('FAIL');
  });
});
