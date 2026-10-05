import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { createConsoleServer, GateStore } from '@planner/gate';
import { readQuery } from '@planner/gate/ui';
import { scheduleIteration } from '@planner/graph-mcp';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T4.2 addendum Step 6, API level: scenes, version, read-only sessions, tables, witness. */

const DEAL = 'nimbus';
let driver: Driver;
let server: Server;
let base = '';

const run = async (name: TemplateName, params: Record<string, unknown>) =>
  (await driver.executeQuery(cypherTemplate(name).query, templateParams(name, params))).records.map((r) => r.toObject());
const get = async <T>(path: string) => {
  const r = await fetch(`${base}${path}`);
  expect(r.status, path).toBe(200);
  return (await r.json()) as T;
};
type Graph = { version: string; nodes: { id: string; labels: string[]; caption: string; emphasis?: string }[]; rels: unknown[]; witness: { check: string; eids: string[] } | null; truncated: boolean };

async function plan(iteration: number, picks: [string, string, string][]) {
  await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await run('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: picks.map(([uc, , finding]) => ({ use_case_id: uc, framing_rationale: 'x', finding_ids: [finding] })),
  });
  await run('write_candidates', {
    deal: DEAL,
    iteration,
    rows: picks.map(([uc, pattern]) => ({ uc, pattern, fit_score: 80, band: 'recommend', signal_snapshot: '{}' })),
  });
  await run('write_selections', { deal: DEAL, iteration, rows: picks.map(([uc, pattern]) => ({ uc, pattern, fit_score: 80, rationale: 'x' })) });
  await run('write_plan_tasks', { deal: DEAL, iteration });
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  server = createConsoleServer(new GateStore(driver), { port: 0, driver, vizDist: mkdtempSync(`${tmpdir()}/viz-`) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  // The server checks Host against its configured port; rebuild it with the real one.
  await new Promise<void>((r) => server.close(() => r()));
  server = createConsoleServer(new GateStore(driver), { port, driver, vizDist: mkdtempSync(`${tmpdir()}/viz-`) });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('scenes', () => {
  it.each([1, 2, 3])('scene %s on a deal with no plan: one row, an empty graph, no witness', async (scene) => {
    const g = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=7&scene=${scene}`);
    expect(g).toMatchObject({ nodes: [], rels: [], witness: null, truncated: false });
    expect(g.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the version is stable when nothing changes and changes when a node is added', async () => {
    await plan(1, [['user-provisioning', 'scim-provisioning', 'f-no-scim']]);
    const a = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=1&scene=2`);
    const b = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=1&scene=2`);
    expect(b.version).toBe(a.version);
    expect(a.nodes.map((n) => n.caption)).toContain('user-provisioning → scim-pr…'); // captions are capped at 28
    expect(a.nodes.filter((n) => n.emphasis === 'draft').length).toBeGreaterThan(0);
    await run('write_candidates', {
      deal: DEAL,
      iteration: 1,
      rows: [{ uc: 'user-provisioning', pattern: 'identity-cutover', fit_score: 49, band: 'surface', signal_snapshot: '{}' }],
    });
    const c = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=1&scene=2`);
    expect(c.version).not.toBe(a.version);
    expect(c.nodes.length).toBe(a.nodes.length + 1);
  });

  it('scene 1 shows patterns and their tasks; scene 3 shows decisions', async () => {
    const k = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=1&scene=1`);
    expect(k.nodes.some((n) => n.labels[0] === 'Pattern')).toBe(true);
    expect(k.nodes.some((n) => n.labels[0] === 'Task')).toBe(true);
    const store = new GateStore(driver);
    const { gate_id } = await store.requestGate({ deal: DEAL, iteration: 1, gate: 'select', subject_ids: ['Selection:user-provisioning'], summary: 's' });
    const d = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=1&scene=3`);
    expect(d.nodes.map((n) => n.caption)).toEqual(expect.arrayContaining(['select: pending', 'user-provisioning → scim-pr…']));
    await store.decide(gate_id, { action: 'approve', comment: '', by: 'a' });
  });

  it('a validator witness (P2 conflict) is returned and emphasized', async () => {
    await plan(2, [
      ['ledger-data-sync', 'cdc-replication', 'f-ledger-sync'],
      ['reporting-consolidation', 'batch-etl-export', 'f-reporting'],
    ]);
    const g = await get<Graph>(`/api/graph?deal=${DEAL}&iteration=2&scene=1`);
    expect(g.witness?.check).toBe('V2');
    expect(g.witness?.eids).toHaveLength(2);
    expect(g.nodes.filter((n) => n.emphasis === 'witness').map((n) => n.caption).sort()).toEqual(['Batch ETL export', 'CDC replication']);
  });
});

describe('reads are read-only', () => {
  it('the UI read session rejects a write', async () => {
    await expect(readQuery(driver, "CREATE (:Strategy {id: 'nope', description: 'x'}) RETURN 1")).rejects.toThrow();
    expect((await driver.executeQuery("MATCH (s:Strategy {id: 'nope'}) RETURN count(s) AS n")).records[0]?.get('n').toNumber()).toBe(0);
  });
});

describe('tables', () => {
  it('say why they are unavailable, and never error', async () => {
    expect(await get(`/api/tables/buy_vs_build?deal=${DEAL}&iteration=1`)).toEqual({ status: 'unavailable', reason: 'no decisions yet' });
    expect(await get(`/api/tables/resource_load?deal=${DEAL}&iteration=1`)).toEqual({ status: 'unavailable', reason: 'not scheduled yet' });
    expect(await get(`/api/tables/iteration_diff?deal=${DEAL}&iteration=1`)).toEqual({ status: 'unavailable', reason: 'needs iteration 2' });
  });

  it('return rows once the data exists', async () => {
    await scheduleIteration(driver, DEAL, 1);
    await run('write_capability_decisions', {
      deal: DEAL,
      iteration: 1,
      rows: [{ capability_id: 'sso', outcome: 'integrate', integrate_effort: 6, build_effort: 20, coverage: 0.7, rule_version: 'bb1-v1' }],
    });
    expect(await get(`/api/tables/buy_vs_build?deal=${DEAL}&iteration=1`)).toMatchObject({ status: 'ok', rows: [['sso', 'integrate', 6, 20, 0.7, 'bb1-v1']] });
    expect(await get<{ status: string; rows: unknown[] }>(`/api/tables/resource_load?deal=${DEAL}&iteration=1`)).toMatchObject({ status: 'ok' });
    const v = await get<{ status: string; rows: unknown[][] }>(`/api/tables/validators?deal=${DEAL}&iteration=1`);
    expect(v.rows.map((r) => r[0])).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V6b', 'V7']);
    expect(await get<{ status: string }>(`/api/tables/iteration_diff?deal=${DEAL}&iteration=2`)).toMatchObject({ status: 'ok' });
  });
});

describe('health, iterations, static', () => {
  it('reports neo4j and gds', async () => {
    expect(await get(`/api/health`)).toMatchObject({ ok: true, neo4j: true, gds: true });
  });
  it('lists iterations newest first', async () => {
    expect((await get<{ n: number }[]>(`/api/iterations?deal=${DEAL}`)).map((i) => i.n)).toEqual([2, 1]);
  });
  it('says how to build the page when viz/dist is missing', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/npm run demo:ui/);
  });
});
