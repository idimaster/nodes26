import { readFileSync } from 'node:fs';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ontology } from '@planner/ontology';
import { applySchema, splitStatements } from '../../graph/apply-schema.js';
import { neo4jConfig } from '../support/neo4j.js';

const schemaFile = new URL('../../graph/schema.cypher', import.meta.url);

describe('splitStatements', () => {
  it('drops comments and blank lines and splits on statement-ending semicolons', () => {
    const text = '// header\nCREATE A;\n\n// note\nCREATE B\n  MORE;\n';
    expect(splitStatements(text)).toEqual(['CREATE A', 'CREATE B\n  MORE']);
  });

  it('rejects a trailing statement without a semicolon', () => {
    expect(() => splitStatements('CREATE A;\nCREATE B')).toThrow(/unterminated/);
  });
});

describe('graph/schema.cypher against Neo4j (T1.2)', () => {
  let driver: Driver;

  async function dropSchema(): Promise<void> {
    const { records: cs } = await driver.executeQuery('SHOW CONSTRAINTS YIELD name RETURN name');
    for (const r of cs) await driver.executeQuery(`DROP CONSTRAINT \`${r.get('name')}\` IF EXISTS`);
    const { records: is } = await driver.executeQuery(
      "SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name",
    );
    for (const r of is) await driver.executeQuery(`DROP INDEX \`${r.get('name')}\` IF EXISTS`);
  }

  beforeAll(async () => {
    const { uri, user, password } = neo4jConfig();
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    await driver.verifyConnectivity();
    await dropSchema();
  });

  afterAll(async () => {
    await driver?.close();
  });

  it('applies twice without error (idempotent)', async () => {
    const text = readFileSync(schemaFile, 'utf8');
    const first = await applySchema(driver, text);
    const second = await applySchema(driver, text);
    expect(first.applied).toBe(36);
    expect(second.applied).toBe(36);
  });

  it('has exactly 23 uniqueness constraints, one per ontology key', async () => {
    const { records } = await driver.executeQuery(
      'SHOW CONSTRAINTS YIELD type, entityType, labelsOrTypes, properties RETURN type, entityType, labelsOrTypes, properties',
    );
    const actual = records.map((r) => {
      expect(r.get('type')).toBe('NODE_PROPERTY_UNIQUENESS');
      expect(r.get('entityType')).toBe('NODE');
      return `${(r.get('labelsOrTypes') as string[]).join()}(${(r.get('properties') as string[]).join()})`;
    });
    const expected = ontology.labels.map((l) => `${l.name}(${l.key.join()})`);
    expect(actual).toHaveLength(23);
    expect(actual.sort()).toEqual(expected.sort());
  });

  it('has a deal_code range index for every per-deal label with a deal_code property', async () => {
    const { records } = await driver.executeQuery(
      "SHOW INDEXES YIELD type, labelsOrTypes, properties, owningConstraint WHERE type = 'RANGE' AND owningConstraint IS NULL RETURN labelsOrTypes, properties",
    );
    const actual = records.map((r) => `${(r.get('labelsOrTypes') as string[]).join()}(${(r.get('properties') as string[]).join()})`);
    const expected = ontology.labels.filter((l) => l.dealProperty === 'deal_code').map((l) => `${l.name}(deal_code)`);
    expect(expected).toHaveLength(13);
    expect(actual.sort()).toEqual(expected.sort());
  });
});
