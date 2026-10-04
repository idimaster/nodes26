import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import raw from '../../config/thresholds.json' with { type: 'json' };
import { nodes, readDataset, relationships } from '@planner/data';
import {
  analyzePatternFit,
  classifyFinding,
  computeSchedule,
  cypherTemplate,
  instantiateTasks,
  templateParams,
  thresholdsSchema,
  type SelectionInput,
  type TemplateName,
} from '@planner/engine';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** Runs every cypher_template against the loaded graph in a small Nimbus flow (T2.1). */

const TH = thresholdsSchema.parse(raw);
const ds = readDataset();
const DEAL = 'nimbus';
const IT = 1;

const ids = (type: string, from: string) =>
  relationships(ds, type)
    .filter((r) => r.from.key.id === from)
    .map((r) => String(r.to.key.id));

function selection(uc: string, pattern: string): SelectionInput {
  return {
    uc,
    pattern,
    requires: ids('REQUIRES', pattern),
    tasks: ids('HAS_TASK', pattern).map((id) => {
      const t = nodes(ds, 'Task').find((x) => x.id === id)!;
      return {
        id,
        weeks_o: Number(t.weeks_o),
        weeks_e: Number(t.weeks_e),
        weeks_p: Number(t.weeks_p),
        skill: String(t.skill),
        depends_on: relationships(ds, 'DEPENDS_ON')
          .filter((r) => r.from.label === 'Task' && r.from.key.id === id)
          .map((r) => String(r.to.key.id)),
      };
    }),
  };
}

describe('cypher templates against Neo4j (T2.1)', () => {
  let driver: Driver;

  const run = async (name: TemplateName, params: unknown) => {
    const { query } = cypherTemplate(name);
    const { records } = await driver.executeQuery(query, templateParams(name, params));
    return records.map((r) => r.toObject());
  };
  const one = async (query: string, params: Record<string, unknown> = {}) =>
    (await driver.executeQuery(query, { deal: DEAL, ...params })).records[0]?.toObject();

  async function writePlan(selections: SelectionInput[]) {
    const { plan_tasks, depends_on } = instantiateTasks({ deal: DEAL, iteration: IT, selections });
    const [written] = await run('write_plan_tasks', {
      deal: DEAL,
      iteration: IT,
      tasks: plan_tasks.map(({ id, uc, task_id, weeks_o, weeks_e, weeks_p, skill }) => ({
        id,
        uc,
        task_id,
        weeks_o,
        weeks_e,
        weeks_p,
        skill,
      })),
      depends_on,
    });
    const schedule = computeSchedule(plan_tasks, depends_on);
    await run('write_schedule', { deal: DEAL, iteration: IT, rows: schedule.tasks });
    return { written, plan_tasks };
  }

  beforeAll(async () => {
    driver = openDriver();
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
  });

  afterAll(async () => {
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
    await driver?.close();
  });

  it('runs a frame -> score -> select -> plan -> repair -> commit flow', async () => {
    expect(await run('set_deal_strategy', { deal: DEAL, strategy: 'bridge' })).toEqual([{ deal: DEAL, strategy: 'bridge' }]);
    expect(await run('create_iteration', { deal: DEAL, n: IT, started_at: '2026-10-05T09:00:00Z' })).toEqual([
      { iteration: expect.anything(), status: 'draft' },
    ]);

    const findings = nodes(ds, 'Finding').filter((f) => f.deal_code === DEAL);
    const [classified] = await run('classify_findings', {
      deal: DEAL,
      rows: findings.map((f) => ({
        id: String(f.id),
        classified_as: classifyFinding(
          { id: String(f.id), kind: String(f.kind), evidence_type: String(f.evidence_type), confidence: Number(f.confidence) },
          TH,
        ),
      })),
    });
    expect(Number(classified?.classified)).toBe(findings.length);

    const framings = [
      { use_case_id: 'user-provisioning', finding_ids: ['f-no-scim'] },
      { use_case_id: 'ledger-data-sync', finding_ids: ['f-ledger-sync'] },
    ];
    const [framed] = await run('write_framed_use_cases', {
      deal: DEAL,
      iteration: IT,
      rows: framings.map((f) => ({ ...f, framing_rationale: `Framed from ${f.finding_ids.join(', ')}.` })),
    });
    expect([Number(framed?.framed), Number(framed?.framed_from)]).toEqual([2, 2]);

    const candidateRows = framings.flatMap((f) => {
      const uc = nodes(ds, 'UseCase').find((u) => u.id === f.use_case_id)!;
      const solvers = relationships(ds, 'SOLVES')
        .filter((r) => r.to.key.id === f.use_case_id)
        .map((r) => String(r.from.key.id));
      return analyzePatternFit(
        {
          use_case: {
            use_case_id: f.use_case_id,
            description: String(uc.description),
            finding_texts: f.finding_ids.map((id) => String(findings.find((x) => x.id === id)!.text)),
          },
          deal_context: {
            strategy: 'bridge',
            target_company: 'Nimbus Ledger',
            acquirer: 'Harborline Software',
            selected_patterns: [],
          },
          candidates: solvers.map((id) => {
            const p = nodes(ds, 'Pattern').find((x) => x.id === id)!;
            return {
              id,
              name: String(p.name),
              description: String(p.description),
              solves: ids('SOLVES', id),
              strategies: ids('APPLIES_TO', id),
              requires: ids('REQUIRES', id),
              not_recommended_when: (p.not_recommended_when as string[] | undefined) ?? [],
            };
          }),
        },
        TH,
      )
        .slice(0, 3)
        .map((a) => ({
          uc: f.use_case_id,
          pattern: a.pattern,
          fit_score: a.score,
          band: a.band,
          signal_snapshot: JSON.stringify(a.signals),
        }));
    });
    const [cands] = await run('write_candidates', { deal: DEAL, iteration: IT, rows: candidateRows });
    expect(Number(cands?.candidates)).toBe(candidateRows.length);

    const top = (uc: string) => candidateRows.find((c) => c.uc === uc)!;
    const [sel] = await run('write_selections', {
      deal: DEAL,
      iteration: IT,
      rows: ['user-provisioning', 'ledger-data-sync'].map((uc) => ({
        uc,
        pattern: top(uc).pattern,
        fit_score: top(uc).fit_score,
        rationale: 'Top-ranked candidate.',
      })),
    });
    expect(Number(sel?.selections)).toBe(2);
    expect(Number(sel?.alternatives)).toBe(candidateRows.length - 2);
    expect(top('ledger-data-sync').pattern).toBe('cdc-replication');

    const first = await writePlan([
      selection('user-provisioning', 'scim-provisioning'),
      selection('ledger-data-sync', 'cdc-replication'),
    ]);
    expect(Number(first.written?.tasks)).toBe(first.plan_tasks.length);

    // Repair: switch ledger-data-sync to its near-miss. Old tasks and edges go; alternatives re-link.
    expect(
      await run('replace_selection', {
        deal: DEAL,
        iteration: IT,
        uc: 'ledger-data-sync',
        pattern: 'event-bus-bridge',
        fit_score: 84.4,
        rationale: 'Near-miss chosen to resolve the CONFLICTS witness.',
      }),
    ).toEqual([{ uc: 'ledger-data-sync', pattern: 'event-bus-bridge', alternatives: expect.anything() }]);
    expect(
      await one(
        `MATCH (s:Selection {deal_code: $deal, uc: 'ledger-data-sync'})
         RETURN toFloat(COUNT { (s)-[:SELECTS]->() }) AS selects, toFloat(COUNT { (s)-[:HAS_TASK]->() }) AS tasks,
                [(c:Candidate)-[:ALTERNATIVE_TO]->(s) | c.pattern] AS alternatives`,
      ),
    ).toEqual({ selects: 1, tasks: 0, alternatives: ['cdc-replication'] });

    const second = await writePlan([
      selection('user-provisioning', 'scim-provisioning'),
      selection('ledger-data-sync', 'event-bus-bridge'),
    ]);
    expect(
      await one(
        `MATCH (pt:PlanTask {deal_code: $deal, iteration: 1})
         RETURN toFloat(count(pt)) AS tasks, toFloat(sum(CASE WHEN pt.task_id STARTS WITH 'cdc-replication.' THEN 1 ELSE 0 END)) AS stale,
                collect(DISTINCT valueType(pt.wave)) AS waveTypes, collect(DISTINCT valueType(pt.iteration)) AS iterationTypes`,
      ),
    ).toEqual({
      tasks: second.plan_tasks.length,
      stale: 0,
      waveTypes: ['INTEGER NOT NULL'],
      iterationTypes: ['INTEGER NOT NULL'],
    });

    const [committed] = await run('commit_roadmap', { deal: DEAL, iteration: IT, version: 1, gate_id: 'gd-test-commit' });
    expect(Number(committed?.included)).toBe(2);
    expect(
      await one(
        `MATCH (r:Roadmap {deal_code: $deal, version: 1}), (i:Iteration {deal_code: $deal, n: 1})
         RETURN r.status AS roadmap, i.status AS iteration, valueType(r.version) AS versionType,
                COLLECT { MATCH (s:Selection {deal_code: $deal, iteration: 1}) RETURN s.status } AS selections`,
      ),
    ).toEqual({ roadmap: 'committed', iteration: 'committed', versionType: 'INTEGER NOT NULL', selections: ['committed', 'committed'] });

    const [decisions] = await run('write_capability_decisions', {
      deal: DEAL,
      iteration: IT,
      rows: [{ capability_id: 'audit-logging', outcome: 'retire', integrate_effort: 4.5, build_effort: 14, coverage: 0.85, rule_version: 'bb1-v1' }],
    });
    expect(Number(decisions?.decisions)).toBe(1);
  });

  it('never re-points, demotes, or deletes anything in a committed iteration', async () => {
    const [sel] = await run('write_selections', {
      deal: DEAL,
      iteration: IT,
      rows: [{ uc: 'ledger-data-sync', pattern: 'cdc-replication', fit_score: 1, rationale: 'sneaky' }],
    });
    expect([Number(sel?.selections), sel?.rejected]).toEqual([0, []]);
    expect(
      await run('replace_selection', {
        deal: DEAL,
        iteration: IT,
        uc: 'ledger-data-sync',
        pattern: 'cdc-replication',
        fit_score: 1,
        rationale: 'sneaky',
      }),
    ).toEqual([]);
    const [framed] = await run('write_framed_use_cases', {
      deal: DEAL,
      iteration: IT,
      rows: [{ use_case_id: 'audit-logging', framing_rationale: 'late', finding_ids: ['f-audit-store'] }],
    });
    expect(Number(framed?.framed)).toBe(0);
    expect(
      await one(
        `MATCH (s:Selection {deal_code: $deal, iteration: 1, uc: 'ledger-data-sync'})
         RETURN s.status AS status, s.pattern AS pattern, toFloat(COUNT { (s)-[:SELECTS]->() }) AS selects,
                toFloat(COUNT { (s)-[:HAS_TASK]->() }) AS tasks`,
      ),
    ).toEqual({ status: 'committed', pattern: 'event-bus-bridge', selects: 1, tasks: 3 });
  });

  it('refuses to reuse a roadmap version for another iteration', async () => {
    await run('create_iteration', { deal: DEAL, n: 2, started_at: '2026-10-06T09:00:00Z' });
    expect(await run('commit_roadmap', { deal: DEAL, iteration: 2, version: 1, gate_id: 'gd-x' })).toEqual([]);
    expect(await one(`MATCH (r:Roadmap {deal_code: $deal, version: 1}) RETURN toFloat(r.iteration) AS iteration`)).toEqual({
      iteration: 1,
    });
  });

  it('in a draft iteration: re-runs are idempotent, re-pointing is rejected, unknown ids are not written', async () => {
    const it2 = 2;
    const frame = (finding_ids: string[]) =>
      run('write_framed_use_cases', {
        deal: DEAL,
        iteration: it2,
        rows: [{ use_case_id: 'user-provisioning', framing_rationale: 'Leavers keep access.', finding_ids }],
      });
    expect(Number((await frame(['f-no-scim', 'f-typo']))[0]?.framed)).toBe(0);
    expect(await one(`RETURN EXISTS { (:FramedUseCase {deal_code: $deal, iteration: 2}) } AS any`)).toEqual({ any: false });
    expect(Number((await frame(['f-no-scim']))[0]?.framed)).toBe(1);

    const select = (pattern: string) =>
      run('write_selections', {
        deal: DEAL,
        iteration: it2,
        rows: [{ uc: 'user-provisioning', pattern, fit_score: 72.3, rationale: 'Top pick.' }],
      });
    const first = await select('scim-provisioning');
    const again = await select('scim-provisioning');
    expect(again).toEqual(first);
    expect((await select('identity-cutover'))[0]?.rejected).toEqual(['user-provisioning']);
    expect(
      await one(
        `MATCH (s:Selection {deal_code: $deal, iteration: 2, uc: 'user-provisioning'})
         RETURN s.pattern AS pattern, [(s)-[:SELECTS]->(p) | p.id] AS selects`,
      ),
    ).toEqual({ pattern: 'scim-provisioning', selects: ['scim-provisioning'] });

    // A PlanTask that a gate decided on, or that has feedback, is never deleted by a repair.
    const { plan_tasks, depends_on } = instantiateTasks({
      deal: DEAL,
      iteration: it2,
      selections: [selection('user-provisioning', 'scim-provisioning')],
    });
    await run('write_plan_tasks', {
      deal: DEAL,
      iteration: it2,
      tasks: plan_tasks.map(({ id, uc, task_id, weeks_o, weeks_e, weeks_p, skill }) => ({ id, uc, task_id, weeks_o, weeks_e, weeks_p, skill })),
      depends_on,
    });
    // Written directly, as the gate server would (agents never write Feedback).
    await driver.executeQuery(
      `MATCH (pt:PlanTask {deal_code: $deal, iteration: 2, id: $id})
       CREATE (:Feedback {id: 'fb-test', deal_code: $deal, text: 'Too slow', status: 'open'})-[:ON]->(pt)`,
      { deal: DEAL, id: plan_tasks[0]!.id },
    );
    expect(
      await run('replace_selection', {
        deal: DEAL,
        iteration: it2,
        uc: 'user-provisioning',
        pattern: 'identity-cutover',
        fit_score: 49,
        rationale: 'Repair.',
      }),
    ).toEqual([]);
    expect(
      await one(`MATCH (pt:PlanTask {deal_code: $deal, iteration: 2}) RETURN toFloat(count(pt)) AS tasks`),
    ).toEqual({ tasks: plan_tasks.length });
  });
});
