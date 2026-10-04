import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T2.5 end to end: the agent long-polls over MCP while the architect decides in the console (HTTP). */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let PORT = 0;
const base = () => `http://127.0.0.1:${PORT}`;

let driver: Driver;
const client = new Client({ name: 'gate-test', version: '0.0.0' });

const payload = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text) as Record<string, unknown>;
const decide = (id: string, body: unknown) =>
  fetch(`${base()}/api/gates/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQ = {
  deal: 'nimbus',
  iteration: 1,
  gate: 'select',
  subject_ids: ['Selection:ledger-data-sync'],
  summary: 'Pick for ledger sync.',
};

/** A free port, found by binding to port 0 (deterministic per run, no collisions). */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  PORT = await freePort();
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.executeQuery(
    `MATCH (d:Deal {code: 'nimbus'})
     CREATE (i:Iteration {deal_code: 'nimbus', n: 1, started_at: datetime(), status: 'draft'})
     CREATE (d)-[:HAS_ITERATION]->(i)
     CREATE (:Selection {deal_code: 'nimbus', iteration: 1, uc: 'ledger-data-sync', pattern: 'cdc-replication', fit_score: 85.3, rationale: 'x', status: 'draft'})
     RETURN 1`,
  );
  await client.connect(
    new StdioClientTransport({
      command: join(ROOT, 'node_modules/.bin/tsx'),
      args: ['packages/gate/bin/gate-mcp.ts'],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), GATE_PORT: String(PORT), GATE_WAIT_SECONDS: '3' },
      stderr: 'pipe',
    }),
  );
}, 30_000);

afterAll(async () => {
  await client.close();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('gate MCP server + console (T2.5)', () => {
  it('serves the three gate tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['await_approval', 'request_approval', 'resolve_feedback']);
  });

  it('request_approval returns the decision made in the console while it waits', async () => {
    const call = client.callTool({ name: 'request_approval', arguments: REQ });
    let pending: { id: string }[] = [];
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await sleep(150);
      pending = (await (await fetch(`${base()}/api/gates?status=pending`)).json()) as { id: string }[];
    }
    expect(pending.map((g) => g.id)).toEqual(['gd-nimbus-1-select-1']);
    const res = await decide('gd-nimbus-1-select-1', { action: 'approve', comment: '', by: 'architect' });
    expect(res.status).toBe(200);
    expect(payload(await call)).toEqual({ status: 'approved', gate_id: 'gd-nimbus-1-select-1', feedback_ids: [], overrides: [] });
  });

  it('returns pending after the wait, and await_approval picks the decision up later', async () => {
    const first = payload(await client.callTool({ name: 'request_approval', arguments: REQ }));
    expect(first).toEqual({ status: 'pending', gate_id: 'gd-nimbus-1-select-2', feedback_ids: [], overrides: [] });
    const call = client.callTool({ name: 'await_approval', arguments: { gate_id: 'gd-nimbus-1-select-2' } });
    await sleep(300);
    await decide('gd-nimbus-1-select-2', { action: 'reject', comment: 'remove cdc-replication', by: 'architect' });
    expect(payload(await call)).toMatchObject({
      status: 'rejected',
      feedback_ids: ['fb-gd-nimbus-1-select-2'],
      overrides: [{ kind: 'exclude_pattern', subject: 'cdc-replication' }],
    });
  });

  it('resolve_feedback over MCP, and errors as tool errors', async () => {
    const ok = await client.callTool({
      name: 'resolve_feedback',
      arguments: { deal: 'nimbus', iteration: 1, feedback_id: 'fb-gd-nimbus-1-select-2', resolved_by_ids: ['Selection:ledger-data-sync'] },
    });
    expect(payload(ok)).toMatchObject({ status: 'resolved' });
    const again = await client.callTool({
      name: 'resolve_feedback',
      arguments: { deal: 'nimbus', iteration: 1, feedback_id: 'fb-gd-nimbus-1-select-2', resolved_by_ids: ['Selection:ledger-data-sync'] },
    });
    expect(again.isError).toBe(true);
    const unknown = await client.callTool({ name: 'request_approval', arguments: { ...REQ, subject_ids: ['Selection:nope'] } });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toMatch(/Selection:nope/);
  });

  it('HTTP: serves the console, and answers 400 / 404 / 409 correctly', async () => {
    const page = await fetch(`${base()}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Approve except/);
    expect((await decide('gd-nimbus-1-select-1', { action: 'approve', comment: '', by: 'a' })).status).toBe(409);
    expect((await decide('gd-nope', { action: 'approve', comment: '', by: 'a' })).status).toBe(404);
    expect((await decide('gd-nimbus-1-select-1', { action: 'maybe', comment: '', by: 'a' })).status).toBe(400);
    expect((await fetch(`${base()}/api/nothing`)).status).toBe(404);
  });
});

describe('console HTTP is safe from other origins (CSRF, DNS rebinding)', () => {
  const post = (headers: Record<string, string>, body = '{"action":"approve","comment":"","by":"x"}') =>
    fetch(`${base()}/api/gates/gd-nimbus-1-select-1/decision`, { method: 'POST', headers, body });

  it('refuses a cross-origin POST', async () => {
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
  });
  it('refuses a simple (text/plain) POST that skips the CORS preflight', async () => {
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
  });
  it('refuses a foreign Host header', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path: '/api/gates', headers: { host: 'evil.example:4646' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(403);
  });
  it('accepts a same-origin JSON POST (it reaches the store: decided gate is 409)', async () => {
    expect((await post({ 'content-type': 'application/json', origin: base() })).status).toBe(409);
  });
  it('refuses an oversized body', async () => {
    expect((await post({ 'content-type': 'application/json' }, JSON.stringify({ action: 'approve', comment: 'x'.repeat(70_000) }))).status).toBe(413);
  });
});
