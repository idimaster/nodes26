import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { GateStore } from '@planner/gate';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/**
 * Fixture steps for the Playwright E2E (T4.2), run with tsx so the browser tests need no TS workspace imports:
 *   reset | step <1-3> | witness | gate <kind> <subject>
 * Plan writes go through the same templates the agent uses.
 */

const DEAL = 'nimbus';
const ITERATION = 1;
const STEPS: Record<string, [string, string, string]> = {
  // Each step keeps the plan valid (prerequisites met), so the only witness is the one planted below.
  '1': ['identity-federation-trust', 'idp-trust-establishment', 'f-customer-sso'],
  '2': ['user-provisioning', 'scim-provisioning', 'f-no-scim'],
  '3': ['ledger-data-sync', 'cdc-replication', 'f-ledger-sync'],
  // P2: batch export conflicts with CDC replication, so V2 fails with both patterns as its witness.
  witness: ['reporting-consolidation', 'batch-etl-export', 'f-reporting'],
};

const driver = openDriver();
const run = async (name: TemplateName, params: Record<string, unknown>) =>
  (await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params))).records.map((r) => r.toObject());

async function pick([uc, pattern, finding]: [string, string, string]) {
  await run('write_framed_use_cases', { deal: DEAL, iteration: ITERATION, rows: [{ use_case_id: uc, framing_rationale: 'fixture', finding_ids: [finding] }] });
  await run('write_candidates', { deal: DEAL, iteration: ITERATION, rows: [{ uc, pattern, fit_score: 80, band: 'recommend', signal_snapshot: '{}' }] });
  await run('write_selections', { deal: DEAL, iteration: ITERATION, rows: [{ uc, pattern, fit_score: 80, rationale: 'fixture' }] });
  await run('write_plan_tasks', { deal: DEAL, iteration: ITERATION });
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'reset') {
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
    await run('create_iteration', { deal: DEAL, n: ITERATION, started_at: '2026-10-05T09:00:00Z' });
  } else if (cmd === 'step' && a && STEPS[a]) await pick(STEPS[a]);
  else if (cmd === 'witness') await pick(STEPS.witness as [string, string, string]);
  else if (cmd === 'gate' && a && b) {
    const { gate_id } = await new GateStore(driver).requestGate({ deal: DEAL, iteration: ITERATION, gate: a as 'select', subject_ids: [b], summary: `E2E ${a} gate` });
    console.log(gate_id);
  } else throw new Error(`usage: reset | step <1-3> | witness | gate <kind> <subject>`);
} finally {
  await driver.close();
}
