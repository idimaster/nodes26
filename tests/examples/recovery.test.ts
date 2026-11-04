import { afterAll, beforeEach, expect, it } from 'vitest';
import { GateStore } from '@planner/gate';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OntologyService } from '../../packages/ontology-mcp/src/service.js';
import { graphCounts } from '../../graph/load/index.js';
import { snapshotRetainedTerms, verifyLoadedDataset } from '../../graph/load/verify.js';
import { neo4jConfig } from '../../graph/connection.js';
import { resetDemo } from '../../packages/harness/src/reset.js';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { assertFreshRun, inspectPlanningState } from '../../packages/harness/src/recovery.js';

const driver = openDriver();
const root = new URL('../..', import.meta.url).pathname;
beforeEach(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await loadAll(driver); });
afterAll(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await driver.executeQuery('DROP CONSTRAINT retained_residency_requirement_key IF EXISTS'); await loadAll(driver); await driver.close(); });

it('permits a loaded clean deal but blocks missing data independently of planning state', async () => {
  await expect(assertFreshRun(driver, 'nimbus')).resolves.toBeDefined();
  await driver.executeQuery('MATCH (f:Finding {deal_code: $deal}) WITH f LIMIT 1 DETACH DELETE f', { deal: 'nimbus' });
  await expect(assertFreshRun(driver, 'nimbus')).rejects.toThrow('DATASET_NOT_READY');
});

it('reports ontology gates after commit but before a response, without new gates/iterations', async () => {
  await driver.executeQuery("CREATE (i:Iteration {deal_code: $deal, n: 1, status: 'draft', started_at: datetime()}) RETURN i.n", { deal: 'nimbus' });
  const store = new GateStore(driver);
  const service = new OntologyService(driver, store, { waitSeconds: 1 });
  const result = await service.proposeTerm({ deal: 'nimbus', iteration: 1, kind: 'relationship', name: 'RESIDENCY_DEPENDS_ON', definition: 'A residency dependency.', example: 'A ledger residency requirement.', motivated_by: ['f-eu-residency'] });
  // Discarding this response simulates the host losing its transcript after the commit.
  const inspected = await inspectPlanningState(driver, 'nimbus');
  expect(inspected.gates.map(g => g.id)).toEqual([result.gate_id]);
  await expect(assertFreshRun(driver, 'nimbus')).rejects.toThrow(result.gate_id);
  const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/planner-recover.ts', 'inspect', '--deal', 'nimbus'], { cwd: root }).catch(e => e as { stdout: string; stderr: string; code: number });
  expect(child.stdout).toContain(result.gate_id);
  expect(child.stderr).toContain('RECOVERY_REQUIRED');
  expect((await inspectPlanningState(driver, 'nimbus')).gates).toHaveLength(1);
});

it('a new process rejects a failed reload with no planning state or local recovery history', async () => {
  await driver.executeQuery('MATCH (n) WHERE n.deal_code IS NOT NULL OR n:Deal DETACH DELETE n RETURN count(*) AS deleted');
  const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/planner-recover.ts', 'inspect', '--deal', 'nimbus'], { cwd: root }).catch(e => e as { stdout: string; stderr: string; code: number });
  expect(child.stderr).toContain('DATASET_NOT_READY');
  expect((await inspectPlanningState(driver, 'nimbus')).gates).toEqual([]);
});

it('preserves a genuinely approved/promoted global label across explicit Compose resets, twice', async () => {
  const baseline = await graphCounts(driver);
  await driver.executeQuery("CREATE (i:Iteration {deal_code: $deal, n: 1, status: 'draft', started_at: datetime()}) RETURN i.n", { deal: 'nimbus' });
  const store = new GateStore(driver);
  const service = new OntologyService(driver, store, { waitSeconds: 1 });
  const term = await service.proposeTerm({ deal: 'nimbus', iteration: 1, kind: 'label', name: 'RetainedResidencyRequirement', definition: 'Customer data must stay in its region.', example: 'EU ledger data stays in EU.', motivated_by: ['f-eu-residency'] });
  await store.decide(term.gate_id, { action: 'approve', comment: '', by: 'architect' });
  const promotion = await store.requestGate({ deal: 'nimbus', iteration: 1, gate: 'ontology_promote', subject_ids: ['OntologyTerm:label/RetainedResidencyRequirement'], summary: 'Retain the approved residency concept globally.' });
  await store.decide(promotion.gate_id, { action: 'approve', comment: '', by: 'architect' });
  const snapshot = await snapshotRetainedTerms(driver);
  expect(snapshot).toHaveLength(1);
  for (let n = 0; n < 2; n++) {
    await resetDemo({ root, graph: neo4jConfig(), driver, deal: 'nimbus' });
    expect(await snapshotRetainedTerms(driver)).toEqual(snapshot);
    const verified = await verifyLoadedDataset(driver, { deal: 'nimbus', mode: 'retain-active-global-terms' });
    expect(verified.baselineCounts).toEqual(baseline);
    expect(verified.physicalCounts.nodes.OntologyTerm).toBe(1);
    expect(verified.retainedTerms).toEqual(['label/RetainedResidencyRequirement']);
    await expect(loadAll(driver)).rejects.toThrow(/DATASET_NOT_READY/);
    await expect(assertFreshRun(driver, 'nimbus')).resolves.toBeDefined();
  }
}, 30_000);

it.each(['proposed', 'rejected', 'scoped', 'multilabeled', 'malformed', 'edge'])('retained verification refuses %s runtime extras', async variant => {
  const status = ['proposed', 'rejected'].includes(variant) ? variant : 'active';
  await driver.executeQuery(`CREATE (t:OntologyTerm {kind: 'relationship', name: 'RESIDENCY_DEPENDS_ON', scope: $scope, status: $status, definition: 'A dependency.', example: 'Residency.', version: 1}) RETURN t.name`, { scope: variant === 'scoped' ? 'nimbus' : 'global', status });
  if (variant === 'multilabeled') await driver.executeQuery('MATCH (t:OntologyTerm) SET t:Finding RETURN t.name');
  if (variant === 'malformed') await driver.executeQuery('MATCH (t:OntologyTerm) REMOVE t.version RETURN t.name');
  if (variant === 'edge') await driver.executeQuery('MATCH (t:OntologyTerm), (d:Deal {code: $deal}) CREATE (t)-[:MOTIVATED_BY]->(d) RETURN t.name', { deal: 'nimbus' });
  await expect(verifyLoadedDataset(driver, { mode: 'retain-active-global-terms' })).rejects.toThrow('DATASET_NOT_READY');
});

it('recovers gate IDs after response loss, including decided and multiple gates', async () => {
  await driver.executeQuery("CREATE (i:Iteration {deal_code: $deal, n: 1, status: 'draft', started_at: datetime()}) RETURN i", { deal: 'nimbus' });
  const store = new GateStore(driver);
  const input = { deal: 'nimbus', iteration: 1, gate: 'frame' as const, subject_ids: ['Iteration:1'], summary: 'Review integration framing' };
  const first = await store.requestGate(input);
  const second = await store.requestGate(input);
  await store.decide(first.gate_id, { action: 'approve', comment: '', by: 'architect' });
  const state = await inspectPlanningState(driver, 'nimbus');
  expect(state.gates.map(g => ({ id: g.id, status: g.status }))).toEqual(expect.arrayContaining([
    { id: first.gate_id, status: 'approved' }, { id: second.gate_id, status: 'pending' },
  ]));
  await expect(assertFreshRun(driver, 'nimbus')).rejects.toThrow('RECOVERY_REQUIRED');
  expect((await inspectPlanningState(driver, 'nimbus')).gates).toHaveLength(2);
});
