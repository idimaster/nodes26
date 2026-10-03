import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neo4jConfig } from '../support/neo4j.js';

describe('neo4j container (T1.1)', () => {
  let driver: Driver;

  beforeAll(async () => {
    const { uri, user, password } = neo4jConfig();
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    await driver.verifyConnectivity();
  });

  afterAll(async () => {
    await driver?.close();
  });

  it('runs Neo4j Community edition', async () => {
    const info = await driver.getServerInfo();
    const { records } = await driver.executeQuery(
      'CALL dbms.components() YIELD edition RETURN edition',
    );
    expect(info.agent).toMatch(/^Neo4j\//);
    expect(records[0]?.get('edition')).toBe('community');
  });

  it('has APOC installed', async () => {
    const { records } = await driver.executeQuery('RETURN apoc.version() AS v');
    expect(records[0]?.get('v')).toMatch(/^\d{4}\.\d+|^\d+\.\d+/);
  });

  it('has GDS installed', async () => {
    const { records } = await driver.executeQuery('RETURN gds.version() AS v');
    expect(records[0]?.get('v')).toMatch(/^\d+\.\d+/);
  });
});
