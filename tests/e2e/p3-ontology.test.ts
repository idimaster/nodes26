import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContext, validate } from '@planner/guard';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.4 acceptance, P3: deny → propose → approve → the write succeeds; the term is invisible to another deal. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
let driver: Driver;
let port = 0;
const clients: Record<string, Client> = {};

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });

async function start(name: string, command: string, args: string[]) {
  const client = new Client({ name: `p3-${name}`, version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), GATE_PORT: String(port), GATE_WAIT_SECONDS: '10' },
      stderr: 'ignore',
    }),
  );
  clients[name] = client;
}
const call = async (server: string, tool: string, args: Record<string, unknown>) => {
  const r = await (clients[server] as Client).callTool({ name: tool, arguments: args });
  return { isError: Boolean(r.isError), body: JSON.parse((r.content as { text: string }[])[0]?.text ?? 'null') as Record<string, unknown> };
};

const WRITE = `MERGE (r:DataResidencyRequirement {deal_code: $deal, id: $id})
SET r.description = $text
RETURN r.id AS id`;
const PARAMS = { deal: 'nimbus', id: 'eu-ledger-data', text: 'EU customer ledgers stay in EU regions, including backups and replicas.' };

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.executeQuery(
    `MATCH (d:Deal {code: 'nimbus'}) CREATE (i:Iteration {deal_code: 'nimbus', n: 1, started_at: datetime(), status: 'draft'})
     CREATE (d)-[:HAS_ITERATION]->(i) RETURN 1`,
  );
  port = await freePort();
  await start('gate', TSX, ['packages/gate/bin/gate-mcp.ts']);
  await start('ontology', TSX, ['packages/ontology-mcp/bin/ontology-mcp.ts']);
  await start('neo4j-write', 'scripts/neo4j-mcp.sh', ['--read-only', 'false']);
}, 60_000);

afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await driver.executeQuery('DROP CONSTRAINT data_residency_requirement_key IF EXISTS');
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('P3: a concept the ontology lacks', () => {
  it('deny → propose → approve → the write succeeds, and only for this deal', async () => {
    // 1. The guard denies the invented label, and says how to get it.
    const denied = await validate(WRITE, PARAMS, await loadContext(driver, 'nimbus'));
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.reason).toMatch(/G6: label `DataResidencyRequirement` .* propose_term/);

    // 2. get_ontology does not have it.
    const before = await call('ontology', 'get_ontology', { deal: 'nimbus' });
    expect((before.body.terms as { name: string }[]).map((t) => t.name)).not.toContain('DataResidencyRequirement');

    // 3. Propose it, while the architect approves in the console.
    const proposal = call('ontology', 'propose_term', {
      deal: 'nimbus',
      iteration: 1,
      kind: 'label',
      name: 'DataResidencyRequirement',
      definition: 'A contractual requirement that customer data stays in a region.',
      example: 'EU customer ledgers stay in EU regions.',
      motivated_by: ['f-eu-residency'],
    });
    let gateId: string | undefined;
    for (let i = 0; i < 50 && !gateId; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const gates = (await (await fetch(`http://127.0.0.1:${port}/api/gates?status=pending`)).json()) as { id: string; gate: string }[];
      gateId = gates.find((g) => g.gate === 'ontology_term')?.id;
    }
    expect(gateId).toBe('gd-nimbus-1-ontology_term-1');
    const res = await fetch(`http://127.0.0.1:${port}/api/gates/${gateId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', comment: '', by: 'architect' }),
    });
    expect(res.status).toBe(200);
    const proposed = await proposal;
    expect(proposed).toMatchObject({ isError: false, body: { status: 'approved', term: { status: 'active', scope: 'nimbus' } } });

    // 4. The same write now passes the guard and runs through neo4j-write; the label has its constraint.
    expect(await validate(WRITE, PARAMS, await loadContext(driver, 'nimbus'))).toEqual({ allow: true });
    const written = await call('neo4j-write', 'write-cypher', { query: WRITE, params: PARAMS });
    expect(written.isError).toBe(false);
    const { records } = await driver.executeQuery(
      `MATCH (r:DataResidencyRequirement {deal_code: 'nimbus', id: 'eu-ledger-data'})
       MATCH (t:OntologyTerm {name: 'DataResidencyRequirement'})-[:MOTIVATED_BY]->(f:Finding)
       RETURN r.description AS d, f.id AS finding`,
    );
    expect(records[0]?.toObject()).toMatchObject({ finding: 'f-eu-residency' });
    const constraint = await driver.executeQuery("SHOW CONSTRAINTS YIELD name WHERE name = 'data_residency_requirement_key' RETURN name");
    expect(constraint.records).toHaveLength(1);

    // 5. Another deal neither sees nor may use it.
    const other = await call('ontology', 'get_ontology', { deal: 'tidewater' });
    expect((other.body.terms as { name: string }[]).map((t) => t.name)).not.toContain('DataResidencyRequirement');
    const tidewater = await validate(WRITE, { ...PARAMS, deal: 'tidewater' }, await loadContext(driver, 'tidewater'));
    expect(tidewater.allow).toBe(false);
  }, 90_000);
});
