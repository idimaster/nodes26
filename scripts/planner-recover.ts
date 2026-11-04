import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertGraphEnvironment, graphEnvironment, neo4jConfig, openDriver } from '../graph/connection.js';
import { assertFreshRun, inspectPlanningState, RESET_SCOPE } from '../packages/harness/src/recovery.js';
import { assertNoManagedRun } from '../packages/harness/src/lock.js';
import { verifyResetTarget } from '../packages/harness/src/reset.js';

const root = fileURLToPath(new URL('..', import.meta.url));
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { deal: { type: 'string', default: 'nimbus' }, 'confirm-reset-demo': { type: 'boolean', default: false } } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['inspect', 'reset'].includes(command ?? '')) throw new Error('usage: planner:recover -- inspect|reset --deal nimbus [--confirm-reset-demo]');
  const deal = values.deal;
  const graph = neo4jConfig();
  assertGraphEnvironment(graph, process.env);
  const driver = openDriver(graph);
  try {
    if (command === 'inspect') {
      console.log(JSON.stringify(await inspectPlanningState(driver, deal), null, 2));
      try { const result = await assertFreshRun(driver, deal); console.log(`READY; retained terms: ${result.readiness.retainedTerms.join(', ') || 'none'}`); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    } else {
      console.log(RESET_SCOPE);
      if (!values['confirm-reset-demo']) throw new Error('reset requires --confirm-reset-demo acknowledging the all-deals reset scope');
      await assertNoManagedRun(root);
      await verifyResetTarget(root, graph, driver);
      try { await promisify(execFile)('bash', ['scripts/reset-demo.sh'], { cwd: root, env: { ...process.env, ...graphEnvironment(graph) }, timeout: 120_000, maxBuffer: 1_000_000 }); }
      catch (error) { throw new Error('demo reset/reload failed; inspect the graph and dataset readiness before retry', { cause: error }); }
      await assertFreshRun(driver, deal);
      console.log('reset complete; selected deal is clean and dataset readiness verified');
    }
  } finally { await driver.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'recovery failed'); process.exitCode = 1; });
