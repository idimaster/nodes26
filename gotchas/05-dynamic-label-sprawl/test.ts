import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { guardDecision, proposeAndApprove } from './after.js';

/** Gotcha 05: dynamic label sprawl. */

const [VARIANT, TERM, QUESTION] = statements(read('05-dynamic-label-sprawl', 'before.cypher')) as [string, string, string];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
  await f.run('create_iteration', { deal: DEAL, n: 1, started_at: '2026-10-05T09:00:00Z' });
});
afterAll(async () => {
  await f.rows('DROP CONSTRAINT data_residency_requirement_key IF EXISTS');
  await f.reset();
  await f.close();
});

describe('05-dynamic-label-sprawl', () => {
  it('before: two near-duplicate labels for one concept, and a query on one misses the other', async () => {
    await f.rows(VARIANT, { deal: DEAL });
    await f.rows(TERM, { deal: DEAL });
    expect(await f.rows(QUESTION, { deal: DEAL })).toEqual([{ ids: ['eu-backups'] }]);
    await f.rows('MATCH (r:DataResidency|DataResidencyRequirement) DETACH DELETE r');
  });

  it('after: the approved, deal-scoped term is accepted and the variant is rejected', async () => {
    expect((await guardDecision(f.driver, TERM, { deal: DEAL })).allow).toBe(false); // not a term yet
    const result = await proposeAndApprove(f.driver, { deal: DEAL, iteration: 1, name: 'DataResidencyRequirement', finding: 'f-eu-residency' });
    expect(result).toMatchObject({ status: 'approved', term: { status: 'active', scope: DEAL } });

    expect(await guardDecision(f.driver, TERM, { deal: DEAL })).toEqual({ allow: true });
    const variant = await guardDecision(f.driver, VARIANT, { deal: DEAL });
    expect(variant.allow).toBe(false);
    if (!variant.allow) expect(variant.reason).toMatch(/G6: label `DataResidency` is not in the ontology/);
    // Scoped to the deal: another deal may not use it.
    expect((await guardDecision(f.driver, TERM, { deal: 'tidewater' })).allow).toBe(false);
  }, 60_000);
});
