import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { GateStore } from '@planner/gate';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T4.1: recall_memory and iteration_diff. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const q = (name: string) => readFileSync(join(ROOT, `graph/queries/skill/${name}.cypher`), 'utf8');
const DEAL = 'nimbus';
let driver: Driver;
let gates: GateStore;

const run = async (name: TemplateName, params: Record<string, unknown>) =>
  (await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params))).records.map((r) => r.toObject());
const recall = async () => (await driver.executeQuery(q('recall_memory'), { deal: DEAL })).records.map((r) => r.toObject());
const diff = async (iteration: number) =>
  (await driver.executeQuery(q('iteration_diff'), { deal: DEAL, iteration: neo4j.int(iteration) })).records.map((r) => r.toObject());

async function plan(iteration: number, picks: [string, string][]) {
  await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await run('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: picks.map(([uc]) => ({ use_case_id: uc, framing_rationale: 'x', finding_ids: ['f-ledger-sync'] })),
  });
  await run('write_selections', { deal: DEAL, iteration, rows: picks.map(([uc, pattern]) => ({ uc, pattern, fit_score: 70, rationale: 'x' })) });
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  gates = new GateStore(driver);
});

afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('memory', () => {
  it('recall_memory with no plan yet: one row, nothing remembered', async () => {
    expect(await recall()).toEqual([{ latest_iteration: null, latest_status: null, selections: [], open_feedback: [], overrides: [] }]);
  });

  it('after a rejection: the latest selections, the open feedback and what it was about, and the active override', async () => {
    await plan(1, [
      ['ledger-data-sync', 'cdc-replication'],
      ['reporting-consolidation', 'batch-etl-export'],
    ]);
    const { gate_id } = await gates.requestGate({ deal: DEAL, iteration: 1, gate: 'select', subject_ids: ['Selection:ledger-data-sync'], summary: 's' });
    await gates.decide(gate_id, { action: 'reject', comment: 'Ledger sync must not read the production database log.\nremove cdc-replication', by: 'architect' });
    expect(await recall()).toEqual([
      {
        latest_iteration: expect.objectContaining({ low: 1 }),
        latest_status: 'draft',
        selections: [
          { uc: 'ledger-data-sync', pattern: 'cdc-replication', status: 'draft' },
          { uc: 'reporting-consolidation', pattern: 'batch-etl-export', status: 'draft' },
        ],
        open_feedback: [
          {
            id: `fb-${gate_id}`,
            text: 'Ledger sync must not read the production database log.\nremove cdc-replication',
            gate: 'select',
            gate_id,
            iteration: expect.objectContaining({ low: 1 }),
            about: ['Selection:ledger-data-sync -> cdc-replication'],
          },
        ],
        overrides: [{ id: `ov-${gate_id}-1`, kind: 'exclude_pattern', subject: 'cdc-replication', value: '' }],
      },
    ]);
  });

  it('iteration_diff: iteration 1 is all additions', async () => {
    expect((await diff(1)).map((r) => [r.uc, r.change, r.before, r.after])).toEqual([
      ['ledger-data-sync', 'added', null, 'cdc-replication'],
      ['reporting-consolidation', 'added', null, 'batch-etl-export'],
    ]);
  });

  it('iteration_diff: a changed, a removed, and an added use case, with the resolving feedback text', async () => {
    await plan(2, [
      ['ledger-data-sync', 'event-bus-bridge'],
      ['webhook-delivery', 'webhook-relay'],
    ]);
    await gates.resolveFeedback({ deal: DEAL, iteration: 2, feedback_id: 'fb-gd-nimbus-1-select-1', resolved_by_ids: ['Selection:ledger-data-sync'] });
    expect(await diff(2)).toEqual([
      {
        uc: 'ledger-data-sync',
        change: 'changed',
        before: 'cdc-replication',
        after: 'event-bus-bridge',
        feedback: ['Ledger sync must not read the production database log.\nremove cdc-replication'],
      },
      { uc: 'reporting-consolidation', change: 'removed', before: 'batch-etl-export', after: null, feedback: [] },
      { uc: 'webhook-delivery', change: 'added', before: null, after: 'webhook-relay', feedback: [] },
    ]);
    // Resolved feedback is no longer remembered as open.
    expect((await recall())[0]?.open_feedback).toEqual([]);
  });

  it('iteration_diff: an unchanged iteration has no rows', async () => {
    await plan(3, [
      ['ledger-data-sync', 'event-bus-bridge'],
      ['webhook-delivery', 'webhook-relay'],
    ]);
    expect(await diff(3)).toEqual([]);
  });
});
