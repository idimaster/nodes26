import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { expect } from 'vitest';
import { loadContext, validate } from '@planner/guard';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { isStateful, writeRecording, type Call } from '../../graph/replay/format.js';
import { startServers } from '../../graph/replay/servers.js';
import { decisions, expectations } from '../../graph/replay/snapshot.js';

/**
 * Shared harness for end-to-end walks of the plan-integration skill without an LLM: every server in
 * .mcp.json over stdio, the skill's own named queries, guard-checked template writes, and the
 * architect deciding gates in the console over HTTP.
 */

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SKILL = readFileSync(join(ROOT, 'plugin/skills/plan-integration/SKILL.md'), 'utf8');
export const QUERIES: Record<string, string> = Object.fromEntries(
  [...SKILL.matchAll(/<!-- query: (\w+) -->\s*```cypher\n([\s\S]*?)```/g)].map((m) => [m[1] as string, (m[2] as string).trim()]),
);

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });

export type Decision = { action: 'approve' | 'approve_except' | 'reject'; comment?: string };

export interface Harness {
  driver: Driver;
  port: number;
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  read: <T = Record<string, unknown>>(name: string, params?: Record<string, unknown>) => Promise<T[]>;
  write: (template: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  gate: (kind: string, iteration: number, subjects: string[], summary: string, decision?: Decision) => Promise<{ status: string; gate_id: string; feedback_ids: string[]; overrides: unknown[] }>;
  close: () => Promise<void>;
}

/**
 * Wipes and reloads the graph, then starts every .mcp.json server. With `record` (or RECORD_REPLAY=<path>),
 * the walk's state-changing calls are written as a replay recording when the harness closes (T4.4).
 */
export async function startHarness(deal: string, opts: { gateWaitSeconds?: number; record?: string } = {}): Promise<Harness> {
  const driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  const port = await freePort();
  const servers = await startServers(ROOT, { GATE_PORT: String(port), GATE_WAIT_SECONDS: String(opts.gateWaitSeconds ?? 5) });
  const record = opts.record ?? process.env.RECORD_REPLAY;
  const calls: Call[] = [];

  const call: Harness['call'] = async (server, tool, args) => {
    const result = await servers.call(server, tool, args);
    if (record && isStateful(server, tool)) calls.push({ kind: 'call', seq: calls.length + 1, server, tool, args, result });
    return result;
  };
  const read: Harness['read'] = async <T>(name: string, params: Record<string, unknown> = {}) => {
    if (!QUERIES[name]) throw new Error(`SKILL.md has no named query ${name}`);
    return (await call('neo4j-read', 'read-cypher', { query: QUERIES[name], params: { deal, ...params } })) as T[];
  };
  const write: Harness['write'] = async (template, params) => {
    const { query } = (await call('planner-engine', 'cypher_template', { name: template })) as { query: string };
    const decision = await validate(query, params, await loadContext(driver, deal));
    expect(decision, `guard on ${template}: ${decision.allow ? '' : decision.reason}`).toEqual({ allow: true });
    const rows = (await call('neo4j-write', 'write-cypher', { query, params })) as Record<string, unknown>[];
    return rows[0] ?? {};
  };
  const gate: Harness['gate'] = async (kind, iteration, subjects, summary, decision = { action: 'approve' }) => {
    const pending = call('gate', 'request_approval', { deal, iteration, gate: kind, subject_ids: subjects, summary });
    let id: string | undefined;
    for (let i = 0; i < 40 && !id; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const gates = (await (await fetch(`http://127.0.0.1:${port}/api/gates?status=pending`)).json()) as { id: string; gate: string; iteration: number }[];
      id = gates.find((g) => g.gate === kind && g.iteration === iteration)?.id;
    }
    expect(id, `the ${kind} gate appears in the console`).toBeDefined();
    const res = await fetch(`http://127.0.0.1:${port}/api/gates/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: '', by: 'architect', ...decision }),
    });
    expect(res.status).toBe(200);
    const result = (await pending) as { status: string; gate_id: string; feedback_ids: string[]; overrides: unknown[] };
    expect(result.status).toBe(decision.action === 'reject' ? 'rejected' : 'approved');
    return result;
  };
  const close = async () => {
    await servers.close();
    if (record) {
      writeRecording(record, {
        header: { kind: 'header', format: 1, deal, source: 'skill-walk', recorded_at: new Date().toISOString(), expect: await expectations(driver, deal) },
        calls,
        decisions: await decisions(driver, deal),
      });
    }
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
    await driver.close();
  };
  return { driver, port, call, read, write, gate, close };
}
