import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { allowedLabels, guardDecision } from './after.js';

/** Gotcha 01: the schema is not a contract. */

const [SCHEMA, INVENTED] = statements(read('01-schema-is-not-a-contract', 'before.cypher')) as [string, string];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.driver.executeQuery('MATCH (n) DETACH DELETE n'); // a fresh database, before any load
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('01-schema-is-not-a-contract', () => {
  it('before: get-schema on an empty graph returns nothing, and an invented label is accepted', async () => {
    const [schema] = await f.rows(SCHEMA);
    expect(schema?.labels).toEqual([]);
    expect(await f.rows(INVENTED, { deal: DEAL })).toEqual([{ id: 'invented-1' }]);
  });

  it('after: get_ontology still lists the allowed labels, and the guard denies the invented one (G6)', async () => {
    await f.driver.executeQuery('MATCH (n) DETACH DELETE n');
    const labels = await allowedLabels(f.driver, DEAL);
    expect(labels).toEqual(expect.arrayContaining(['Pattern', 'Selection', 'Finding']));
    expect(labels).not.toContain('IntegrationThing');
    const decision = await guardDecision(f.driver, INVENTED, { deal: DEAL });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toMatch(/G6: label `IntegrationThing` is not in the ontology.*propose_term/);
  });
});
