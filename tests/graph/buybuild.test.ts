import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import raw from '../../config/thresholds.json' with { type: 'json' };
import { classifyBuyBuild, classifyFinding, cypherTemplate, templateParams, thresholdsSchema, type TemplateName } from '@planner/engine';
import { nodes, readDataset, readPlanted } from '@planner/data';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.6: BB1 + classify_buy_build write CapabilityDecisions; P6 outcomes match DATA.md exactly. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BB1 = readFileSync(join(ROOT, 'graph/queries/skill/bb1.cypher'), 'utf8');
const TH = thresholdsSchema.parse(raw);
const DEAL = 'nimbus';
const planted = readPlanted();
let driver: Driver;

const run = async (name: TemplateName, params: Record<string, unknown>) =>
  (await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params))).records.map((r) => r.toObject());

async function plan(iteration: number, picks: { uc: string; pattern: string; finding: string }[]) {
  await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await run('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: picks.map((p) => ({ use_case_id: p.uc, framing_rationale: `From ${p.finding}.`, finding_ids: [p.finding] })),
  });
  await run('write_selections', { deal: DEAL, iteration, rows: picks.map((p) => ({ uc: p.uc, pattern: p.pattern, fit_score: 70, rationale: 'x' })) });
  await run('write_plan_tasks', { deal: DEAL, iteration });
}

type Row = { capability_id: string; finding_ids: string[]; integrate_effort: number | null; build_effort: number; coverage: number };
const bb1 = async (iteration: number) =>
  (await driver.executeQuery(BB1, { deal: DEAL, iteration: neo4j.int(iteration) })).records.map((r) => r.toObject() as Row);

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  // Step 2 of the skill: store classify_finding's result on every Nimbus finding.
  const findings = nodes(readDataset(), 'Finding').filter((f) => f.deal_code === DEAL);
  await run('classify_findings', {
    deal: DEAL,
    rows: findings.map((f) => ({
      id: String(f.id),
      classified_as: classifyFinding({ id: String(f.id), kind: String(f.kind), evidence_type: String(f.evidence_type), confidence: Number(f.confidence) }, TH),
    })),
  });
});

afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('BB1', () => {
  it('has one row per strongly evidenced capability, and none for an assumption', async () => {
    await plan(1, planted.P6.map((c) => ({ uc: c.use_case, pattern: c.pattern, finding: c.finding })));
    const rows = await bb1(1);
    // Filler "capabilities" with weak evidence were classified as assumptions and are not rows.
    expect(rows.map((r) => r.capability_id)).toEqual(['audit-logging', 'billing-ledger', 'sso']);
    expect(rows.map((r) => [r.capability_id, r.integrate_effort, r.build_effort, r.coverage])).toEqual([
      ['audit-logging', 4.5, 14, 0.85],
      ['billing-ledger', 13, 14, 0.5],
      ['sso', 6, 20, 0.7],
    ]);
  });

  it('P6: the written CapabilityDecisions are integrate / retire / review, exactly as planted', async () => {
    const { outcomes, unplanned, rule_version } = classifyBuyBuild(await bb1(1), TH);
    expect(unplanned).toEqual([]);
    const [written] = await run('write_capability_decisions', {
      deal: DEAL,
      iteration: 1,
      rows: outcomes.map((o) => ({ capability_id: o.capability_id, outcome: o.outcome, integrate_effort: o.integrate_effort, build_effort: o.build_effort, coverage: o.coverage, rule_version })),
    });
    expect(Number(written?.decisions)).toBe(3);
    const { records } = await driver.executeQuery(
      `MATCH (:Deal {code: $deal})-[:HAS_DECISION]->(c:CapabilityDecision {deal_code: $deal, iteration: 1})
       RETURN c.capability_id AS capability, c.outcome AS outcome, c.rule_version AS version, valueType(c.iteration) AS iterationType
       ORDER BY capability`,
      { deal: DEAL },
    );
    expect(records.map((r) => r.toObject())).toEqual(
      planted.P6.map((c) => ({ capability: c.capability, outcome: c.expected, version: 'bb1-v1', iterationType: 'INTEGER NOT NULL' })).sort(
        (a, b) => a.capability.localeCompare(b.capability),
      ),
    );
  });

  it('a capability without a Selection is unplanned, and no decision is written for it', async () => {
    const sso = planted.P6.find((c) => c.capability === 'sso')!;
    await plan(2, [{ uc: sso.use_case, pattern: sso.pattern, finding: sso.finding }]);
    const { outcomes, unplanned } = classifyBuyBuild(await bb1(2), TH);
    expect(outcomes.map((o) => [o.capability_id, o.outcome])).toEqual([['sso', 'integrate']]);
    expect(unplanned).toEqual(['audit-logging', 'billing-ledger']);
  });
});
