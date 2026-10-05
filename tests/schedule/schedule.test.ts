import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { computeIterationSchedule, gdsAvailable, scheduleIteration } from '@planner/graph-mcp';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.2: GDS and Kahn agree; a cycle refuses to schedule; the probe falls back loudly; write-back is complete. */

let driver: Driver;
const DEAL = 'nimbus';
const run = async (name: TemplateName, params: Record<string, unknown>) =>
  (await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params))).records.map((r) => r.toObject());

async function plan(iteration: number, picks: [string, string][], finding = 'f-no-scim') {
  await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await run('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: picks.map(([uc]) => ({ use_case_id: uc, framing_rationale: 'Fixture.', finding_ids: [finding] })),
  });
  await run('write_selections', { deal: DEAL, iteration, rows: picks.map(([uc, pattern]) => ({ uc, pattern, fit_score: 70, rationale: 'x' })) });
  await run('write_plan_tasks', { deal: DEAL, iteration });
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  // A Nimbus plan with cross-pattern REQUIRES edges and a pattern used twice.
  await plan(1, [
    ['identity-federation-trust', 'idp-trust-establishment'],
    ['workforce-sso', 'oidc-broker'],
    ['customer-sso', 'oidc-broker'],
    ['user-provisioning', 'scim-provisioning'],
    ['ledger-data-sync', 'event-bus-bridge'],
    ['billing-consolidation', 'billing-ledger-integration'],
  ]);
});

afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('capability probe', () => {
  it('finds gds.dag.longestPath.stream in the pinned GDS', async () => {
    expect(await gdsAvailable(driver)).toBe(true);
  });
});

describe('GDS and Kahn agree (parity)', () => {
  it.each([
    ['tidewater', 1],
    ['quarry', 1],
    ['nimbus', 1],
  ])('%s iteration %s', async (deal, iteration) => {
    const gds = await computeIterationSchedule(driver, deal, iteration, { engine: 'gds' });
    const kahn = await computeIterationSchedule(driver, deal, iteration, { engine: 'kahn' });
    expect(gds.status).toBe('scheduled');
    expect(gds).toEqual({ ...kahn, engine: 'gds' });
    if (gds.status === 'scheduled') expect(gds.schedule.tasks.length).toBeGreaterThan(10);
  });

  it('reproduces the stored history schedules (generated with the engine)', async () => {
    const r = await computeIterationSchedule(driver, 'tidewater', 1, { engine: 'gds' });
    if (r.status !== 'scheduled') throw new Error('not scheduled');
    const { records } = await driver.executeQuery(
      "MATCH (pt:PlanTask {deal_code: 'tidewater', iteration: 1}) RETURN pt.id AS id, pt.earliest_start AS es, pt.wave AS wave, pt.on_critical_path AS c",
    );
    const stored = new Map(records.map((x) => [x.get('id') as string, x.toObject()]));
    for (const t of r.schedule.tasks) {
      const s = stored.get(t.id) as { es: number; wave: unknown; c: boolean };
      expect([t.earliest_start, t.wave, t.on_critical_path], t.id).toEqual([s.es, Number(s.wave), s.c]);
    }
  });
});

describe('scheduleIteration (what the agent asks for)', () => {
  it('writes earliest_start, wave, and on_critical_path on every PlanTask and reports resource load', async () => {
    const r = await scheduleIteration(driver, DEAL, 1);
    expect(r).toMatchObject({ status: 'scheduled', engine: 'gds', tasks: 21 });
    if (r.status !== 'scheduled') return;
    expect(r.finish).toBeGreaterThan(0);
    expect(r.critical_path.length).toBeGreaterThan(0);
    expect(r.resource_load.reduce((s, x) => s + x.weeks, 0)).toBeCloseTo(
      (await driver.executeQuery("MATCH (pt:PlanTask {deal_code: 'nimbus', iteration: 1}) RETURN sum(pt.weeks_e) AS w")).records[0]?.get('w') as number,
      6,
    );
    const { records } = await driver.executeQuery(
      `MATCH (pt:PlanTask {deal_code: 'nimbus', iteration: 1})
       RETURN count(pt) AS n, count(pt.earliest_start) AS es, count(pt.on_critical_path) AS c,
              collect(DISTINCT valueType(pt.wave)) AS waveType`,
    );
    expect(records[0]?.toObject()).toMatchObject({ waveType: ['INTEGER NOT NULL'] });
    expect([Number(records[0]?.get('n')), Number(records[0]?.get('es')), Number(records[0]?.get('c'))]).toEqual([21, 21, 21]);
  });

  it('P5: refuses to schedule a cycle, returns the witness, and writes nothing', async () => {
    await plan(2, [['container-platform-migration', 'container-replatform-fastpath']], 'f-vm-hosting');
    const r = await scheduleIteration(driver, DEAL, 2);
    const p = 'container-platform-migration:container-replatform-fastpath.';
    expect(r).toEqual({
      status: 'cycle',
      source: 'V3',
      witness: [`${p}cluster-onboarding`, `${p}deploy-manifests`, `${p}image-build`, `${p}cluster-onboarding`],
    });
    const { records } = await driver.executeQuery(
      "MATCH (pt:PlanTask {deal_code: 'nimbus', iteration: 2}) RETURN count(pt.earliest_start) + count(pt.wave) AS written",
    );
    expect(Number(records[0]?.get('written'))).toBe(0);
  });

  it('a cycle longer than V3 checks is still refused, with the engine witness', async () => {
    await run('create_iteration', { deal: DEAL, n: 3, started_at: '2026-10-05T09:00:00Z' });
    await driver.executeQuery(
      `MATCH (i:Iteration {deal_code: 'nimbus', n: 3})
       UNWIND range(0, 11) AS k
       CREATE (t:PlanTask {deal_code: 'nimbus', iteration: 3, id: 'c:' + right('0' + toString(k), 2), task_id: 't', weeks_o: 1, weeks_e: 1, weeks_p: 1, skill: 'ops', status: 'draft'})
       CREATE (t)-[:IN_ITERATION]->(i)
       WITH collect(t) AS ts
       UNWIND range(0, 11) AS k
       WITH ts[k] AS a, ts[(k + 1) % 12] AS b
       CREATE (a)-[:DEPENDS_ON]->(b)
       RETURN count(*)`,
    );
    const r = await scheduleIteration(driver, DEAL, 3);
    expect(r).toMatchObject({ status: 'cycle', source: 'schedule' });
    if (r.status === 'cycle') expect(r.witness).toHaveLength(13);
  });

  it('nothing to schedule is an error, not an empty success', async () => {
    await expect(scheduleIteration(driver, DEAL, 42)).rejects.toThrow(/no PlanTasks/);
  });

  it('without the GDS procedure it says so, and schedules with Kahn to the same result', async () => {
    const warnings: string[] = [];
    const r = await scheduleIteration(driver, DEAL, 1, { probe: async () => false, warn: (m) => warnings.push(m) });
    expect(r).toMatchObject({ status: 'scheduled', engine: 'kahn' });
    expect(warnings).toEqual([expect.stringMatching(/gds\.dag\.longestPath\.stream is not available.*Kahn/)]);
    const gds = await scheduleIteration(driver, DEAL, 1);
    expect({ ...r, engine: 'gds' }).toEqual(gds);
  });
});

describe('review fixes', () => {
  it('parity on a synthetic plan with an isolated task, a diamond, and ties', async () => {
    await run('create_iteration', { deal: DEAL, n: 5, started_at: '2026-10-05T09:00:00Z' });
    await driver.executeQuery(
      `MATCH (i:Iteration {deal_code: 'nimbus', n: 5})
       UNWIND [['s:a', 2.0], ['s:b', 1.0], ['s:c', 1.0], ['s:d', 3.0], ['s:e', 0.5], ['s:lone', 4.0]] AS row
       CREATE (t:PlanTask {deal_code: 'nimbus', iteration: 5, id: row[0], task_id: 't', weeks_o: row[1] / 2, weeks_e: row[1], weeks_p: row[1] * 2, skill: 'ops', status: 'draft'})
       CREATE (t)-[:IN_ITERATION]->(i)
       WITH collect(t) AS ts
       WITH ts[0] AS a, ts[1] AS b, ts[2] AS c, ts[3] AS d, ts[4] AS e
       CREATE (b)-[:DEPENDS_ON]->(a), (c)-[:DEPENDS_ON]->(a), (d)-[:DEPENDS_ON]->(b), (d)-[:DEPENDS_ON]->(c), (e)-[:DEPENDS_ON]->(a)
       RETURN 1`,
    );
    const gds = await computeIterationSchedule(driver, DEAL, 5, { engine: 'gds' });
    const kahn = await computeIterationSchedule(driver, DEAL, 5, { engine: 'kahn' });
    expect(gds).toEqual({ ...kahn, engine: 'gds' });
    if (gds.status !== 'scheduled') throw new Error('not scheduled');
    const byId = Object.fromEntries(gds.schedule.tasks.map((x) => [x.id, [x.earliest_start, x.wave, x.on_critical_path]]));
    expect(byId).toEqual({
      's:a': [0, 1, true],
      's:b': [2, 2, true],
      's:c': [2, 2, true],
      's:d': [3, 3, true],
      's:e': [2, 2, false],
      's:lone': [0, 1, false],
    });
  });

  it('a re-plan clears the old schedule, so a cycle afterwards leaves no stale values', async () => {
    expect(await scheduleIteration(driver, DEAL, 1)).toMatchObject({ status: 'scheduled' });
    await run('write_plan_tasks', { deal: DEAL, iteration: 1 });
    const { records } = await driver.executeQuery(
      "MATCH (pt:PlanTask {deal_code: 'nimbus', iteration: 1}) RETURN count(pt.earliest_start) + count(pt.wave) + count(pt.on_critical_path) AS stale",
    );
    expect(Number(records[0]?.get('stale'))).toBe(0);
    expect(await scheduleIteration(driver, DEAL, 1)).toMatchObject({ status: 'scheduled' });
  });

  it('the probe reports a real error instead of pretending GDS is absent', async () => {
    const broken = { executeQuery: async () => Promise.reject(Object.assign(new Error('auth failed'), { code: 'Neo.ClientError.Security.Unauthorized' })) };
    await expect(gdsAvailable(broken as unknown as Driver)).rejects.toThrow(/auth failed/);
  });
});
