import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Driver } from 'neo4j-driver';
import { expect } from 'vitest';
import { loadContext, validate } from '@planner/guard';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

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
const MCP = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as {
  mcpServers: Record<string, { command: string; args?: string[] }>;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

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

/** Wipes and reloads the graph, then starts every .mcp.json server. */
export async function startHarness(deal: string, opts: { gateWaitSeconds?: number } = {}): Promise<Harness> {
  const driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  const port = await freePort();
  const clients: Record<string, Client> = {};
  for (const [name, entry] of Object.entries(MCP.mcpServers)) {
    const client = new Client({ name: `walk-${name}`, version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), GATE_PORT: String(port), GATE_WAIT_SECONDS: String(opts.gateWaitSeconds ?? 5) },
        stderr: 'ignore',
      }),
    );
    clients[name] = client;
  }

  const call: Harness['call'] = async (server, tool, args) => {
    const r = await (clients[server] as Client).callTool({ name: tool, arguments: args });
    if (r.isError) throw new Error(`${server}.${tool} failed: ${text(r)}`);
    return JSON.parse(text(r));
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
    for (const c of Object.values(clients)) await c.close();
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
    await driver.close();
  };
  return { driver, port, call, read, write, gate, close };
}
