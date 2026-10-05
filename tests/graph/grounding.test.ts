import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.5: candidate retrieval minus Overrides, prior-project estimates, and the estimate_provenance call path. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const query = (name: string) => readFileSync(join(ROOT, `graph/queries/skill/${name}.cypher`), 'utf8');
let driver: Driver;
const engine = new Client({ name: 'grounding-test', version: '0.0.0' });

const candidates = async (deal: string, useCase: string) =>
  (await driver.executeQuery(query('candidates'), { deal, use_case: useCase })).records.map((r) => r.get('id') as string);

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await engine.connect(
    new StdioClientTransport({ command: join(ROOT, 'node_modules/.bin/tsx'), args: ['packages/engine-mcp/src/server.ts'], cwd: ROOT, stderr: 'ignore' }),
  );
}, 30_000);

afterAll(async () => {
  await engine.close();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('candidate retrieval, minus Overrides', () => {
  it('returns every pattern that SOLVES the use case', async () => {
    expect(await candidates('nimbus', 'ledger-data-sync')).toEqual(['cdc-replication', 'event-bus-bridge']);
  });

  it("drops a pattern an active exclude_pattern Override of this deal names, and only that one", async () => {
    await driver.executeQuery(
      `CREATE (:Override {id: 'ov-g-1', deal_code: 'nimbus', kind: 'exclude_pattern', subject: 'cdc-replication', value: '', active: true})
       CREATE (:Override {id: 'ov-g-2', deal_code: 'nimbus', kind: 'exclude_pattern', subject: 'event-bus-bridge', value: '', active: false})
       CREATE (:Override {id: 'ov-g-3', deal_code: 'tidewater', kind: 'exclude_pattern', subject: 'event-bus-bridge', value: '', active: true})
       CREATE (:Override {id: 'ov-g-4', deal_code: 'nimbus', kind: 'pin_pattern', subject: 'event-bus-bridge', value: '', active: true})`,
    );
    try {
      expect(await candidates('nimbus', 'ledger-data-sync')).toEqual(['event-bus-bridge']);
      expect(await candidates('tidewater', 'ledger-data-sync')).toEqual(['cdc-replication']);
    } finally {
      await driver.executeQuery("MATCH (o:Override) WHERE o.id STARTS WITH 'ov-g-' DETACH DELETE o");
    }
  });
});

describe('prior-project estimates', () => {
  it('return at least 3 observations for at least 5 tasks', async () => {
    const all = (await driver.executeQuery('MATCH (t:Task) RETURN collect(t.id) AS ids')).records[0]?.get('ids') as string[];
    const { records } = await driver.executeQuery(query('prior_estimates'), { task_ids: all });
    const wellObserved = records.filter((r) => neo4j.integer.toNumber(r.get('n')) >= 3).map((r) => r.get('task_id') as string);
    expect(wellObserved.length).toBeGreaterThanOrEqual(5);
    expect(records).toHaveLength(all.length); // one row per asked task, observed or not
  });
});

describe('the estimate_provenance call path', () => {
  it('matches the hand-computed fixture for oidc-broker.claims-mapping', async () => {
    const { records } = await driver.executeQuery(query('prior_estimates'), { task_ids: ['oidc-broker.claims-mapping'] });
    const row = records[0]?.toObject() as { task_id: string; weeks_o: number; weeks_e: number; weeks_p: number; observations: number[] };
    // Catalog estimate 1 / 2 / 3; observed 2.8 (tidewater, workforce-sso), 2.7 (tidewater, customer-sso), 2.9 (quarry).
    expect([...row.observations].sort()).toEqual([2.7, 2.8, 2.9]);
    const r = await engine.callTool({
      name: 'estimate_provenance',
      arguments: { task: { id: row.task_id, weeks_o: row.weeks_o, weeks_e: row.weeks_e, weeks_p: row.weeks_p }, observations: row.observations, modifiers: [] },
    });
    // By hand: mean (2.8 + 2.7 + 2.9) / 3 = 2.8; n = 3 meets min_observations, so result = 2.8;
    // band = [1, 3] * 2.8 / 2 = [1.4, 4.2].
    expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}')).toEqual({
      task_id: 'oidc-broker.claims-mapping',
      baseline: 2,
      history_avg: 2.8,
      n: 3,
      modifiers: [],
      result: 2.8,
      band: [1.4, 4.2],
    });
  });

  it('an unobserved task keeps its catalog baseline', async () => {
    const { records } = await driver.executeQuery(query('prior_estimates'), { task_ids: ['billing-ledger-integration.parallel-billing'] });
    expect(records[0]?.toObject()).toMatchObject({ n: expect.objectContaining({ low: 0 }), history_avg: null, observations: [] });
  });
});
