import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** The standalone console (npm run console) serves the page and the API without any MCP session. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let proc: ChildProcess;
let port = 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  port = await freePort();
  proc = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['packages/gate/bin/console.ts'], {
    cwd: ROOT,
    env: { ...process.env, GATE_PORT: String(port) },
  });
  await new Promise<void>((resolve, reject) => {
    proc.stdout?.on('data', (d: Buffer) => d.toString().includes('open http') && resolve());
    proc.on('exit', (code) => reject(new Error(`console exited with ${code}`)));
  });
}, 30_000);

afterAll(() => {
  proc?.kill('SIGTERM');
});

describe('standalone console', () => {
  it('serves the page and the pending-gates API', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Gate console/);
    const gates = await fetch(`http://127.0.0.1:${port}/api/gates?status=pending`);
    expect(gates.status).toBe(200);
    expect(Array.isArray(await gates.json())).toBe(true);
  });

  it('a second console on the same port says who already serves it, and exits', async () => {
    const second = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['packages/gate/bin/console.ts'], {
      cwd: ROOT,
      env: { ...process.env, GATE_PORT: String(port) },
    });
    let err = '';
    second.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    expect(code).toBe(1);
    expect(err).toMatch(/already serves the console/);
  }, 30_000);
});

describe('a gate MCP server started while the console holds the port', () => {
  it('still returns the decision made in the console (through the graph)', async () => {
    const driver = openDriver();
    await driver.executeQuery(
      `MATCH (d:Deal {code: 'nimbus'})
       MERGE (i:Iteration {deal_code: 'nimbus', n: 9})
       ON CREATE SET i.started_at = datetime(), i.status = 'draft'
       MERGE (d)-[:HAS_ITERATION]->(i)
       RETURN i.n`,
    );
    const client = new Client({ name: 'console-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: join(ROOT, 'node_modules/.bin/tsx'),
        args: ['packages/gate/bin/gate-mcp.ts'],
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), GATE_PORT: String(port), GATE_WAIT_SECONDS: '10' },
        stderr: 'ignore',
      }),
    );
    try {
      const pending = client.callTool({
        name: 'request_approval',
        arguments: { deal: 'nimbus', iteration: 9, gate: 'frame', subject_ids: ['Iteration:9'], summary: 'Console on its own.' },
      });
      let id: string | undefined;
      for (let i = 0; i < 40 && !id; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const gates = (await (await fetch(`http://127.0.0.1:${port}/api/gates?status=pending`)).json()) as { id: string; iteration: number }[];
        id = gates.find((g) => g.iteration === 9)?.id;
      }
      expect(id).toBeDefined();
      const res = await fetch(`http://127.0.0.1:${port}/api/gates/${id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', comment: '', by: 'architect' }),
      });
      expect(res.status).toBe(200);
      const result = JSON.parse(((await pending) as { content: { text: string }[] }).content[0]?.text ?? '{}') as { status: string };
      expect(result.status).toBe('approved');
    } finally {
      await client.close();
      await driver.executeQuery('MATCH (n) DETACH DELETE n');
      await loadAll(driver);
      await driver.close();
    }
  }, 60_000);
});

describe('decisions reach a waiting agent in another process quickly (T4.2)', () => {
  it('within about a second (500 ms graph polling)', async () => {
    const driver = openDriver();
    await driver.executeQuery(
      `MATCH (d:Deal {code: 'nimbus'})
       MERGE (i:Iteration {deal_code: 'nimbus', n: 8})
       ON CREATE SET i.started_at = datetime(), i.status = 'draft'
       MERGE (d)-[:HAS_ITERATION]->(i)
       RETURN i.n`,
    );
    const client = new Client({ name: 'console-latency', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: join(ROOT, 'node_modules/.bin/tsx'),
        args: ['packages/gate/bin/gate-mcp.ts'],
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), GATE_HTTP: 'off', GATE_WAIT_SECONDS: '10' },
        stderr: 'ignore',
      }),
    );
    try {
      const pending = client.callTool({
        name: 'request_approval',
        arguments: { deal: 'nimbus', iteration: 8, gate: 'frame', subject_ids: ['Iteration:8'], summary: 'Latency.' },
      });
      let id: string | undefined;
      for (let i = 0; i < 40 && !id; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const gates = (await (await fetch(`http://127.0.0.1:${port}/api/gates?status=pending&deal=nimbus`)).json()) as { id: string; iteration: number }[];
        id = gates.find((g) => g.iteration === 8)?.id;
      }
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/gates/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(res.status).toBe(200);
      await pending;
      expect(Date.now() - t0).toBeLessThan(1200);
      const again = await fetch(`http://127.0.0.1:${port}/api/gates/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reject', comment: 'x' }),
      });
      expect(again.status).toBe(409);
    } finally {
      await client.close();
      await driver.close();
    }
  }, 60_000);

  it('GATE_HTTP=off: the agent-side gate process serves no console', async () => {
    const { spawn } = await import('node:child_process');
    const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['packages/gate/bin/gate-mcp.ts'], {
      cwd: ROOT,
      env: { ...process.env, GATE_HTTP: 'off', GATE_PORT: String(port + 1) },
    });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    await new Promise((r) => setTimeout(r, 2500));
    p.kill('SIGTERM');
    expect(err).toMatch(/console off \(GATE_HTTP=off\)/);
    await expect(fetch(`http://127.0.0.1:${port + 1}/`)).rejects.toThrow();
  }, 30_000);
});
