import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_DIR, type Dataset } from '@planner/data';
import { openDriver } from '../../graph/connection.js';
import { graphCounts, loadAll } from '../../graph/load/index.js';
import { writeDataset } from '../../graph/load/write.js';

const manifest: unknown = JSON.parse(readFileSync(join(DATA_DIR, 'manifest.json'), 'utf8'));

describe('loaders (T1.4)', () => {
  let driver: Driver;

  const wipe = () => driver.executeQuery('MATCH (n) DETACH DELETE n');

  beforeAll(async () => {
    driver = openDriver();
    await driver.verifyConnectivity();
    await wipe();
  });

  afterAll(async () => {
    // Leave the database fully loaded for whoever uses it next.
    await wipe();
    await loadAll(driver);
    await driver?.close();
  });

  it('loads a fresh database to exactly the manifest counts', async () => {
    const counts = await loadAll(driver);
    expect(counts).toEqual(manifest);
    expect(await graphCounts(driver)).toEqual(manifest);
  });

  it('gives identical counts when loaded a second time (idempotent)', async () => {
    const before = await graphCounts(driver);
    await loadAll(driver);
    expect(await graphCounts(driver)).toEqual(before);
  });

  it('stores integers, datetimes, and relationship properties with the ontology types', async () => {
    const { records } = await driver.executeQuery(
      `MATCH (i:Iteration {deal_code: 'tidewater', n: 1})
       MATCH (a:Actual {deal_code: 'tidewater'})
       MATCH (:PlatformCapability {id: 'audit-pipeline'})-[p:PROVIDES]->(:CapabilityType {id: 'audit-logging'})
       WITH i, p, a LIMIT 1
       RETURN valueType(i.n) AS n, valueType(i.started_at) AS started, valueType(a.completed_at) AS completed,
              valueType(a.weeks_actual) AS weeks, p.coverage AS coverage`,
    );
    expect(records[0]?.toObject()).toEqual({
      n: 'INTEGER NOT NULL',
      started: 'ZONED DATETIME NOT NULL',
      completed: 'ZONED DATETIME NOT NULL',
      weeks: 'FLOAT NOT NULL',
      coverage: 0.85,
    });
  });

  it('keeps list properties as lists', async () => {
    const { records } = await driver.executeQuery(
      "MATCH (p:Pattern {id: 'strangler-fig'}) RETURN size(p.not_recommended_when) AS rules",
    );
    expect(neo4j.integer.toNumber(records[0]?.get('rules'))).toBe(2);
  });

  it('throws instead of silently dropping a relationship whose endpoint is missing', async () => {
    const dangling: Dataset = {
      nodes: {},
      relationships: {
        IN_TRACK: [
          {
            type: 'IN_TRACK',
            from: { label: 'Pattern', key: { id: 'strangler-fig' } },
            to: { label: 'Track', key: { id: 'no-such-track' } },
            props: {},
          },
        ],
      },
    };
    await expect(writeDataset(driver, dangling)).rejects.toThrow(/IN_TRACK.*1 of 1 .*missing endpoint/);
  });

  it('refuses a label that is not in the ontology', async () => {
    const bad: Dataset = { nodes: { 'Track`) DETACH DELETE (x': [{ id: 'x' }] }, relationships: {} };
    await expect(writeDataset(driver, bad)).rejects.toThrow(/not in the ontology/);
  });
});
