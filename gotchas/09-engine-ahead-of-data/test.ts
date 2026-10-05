import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { checks, coverageFloor } from './after.js';

/** Gotcha 09: the engine ahead of the data. */

const [SPARSE] = statements(read('09-engine-ahead-of-data', 'before.cypher')) as [string];
// Three API patterns keep their edges with each other; nothing the plan below uses is among them.
const ISLAND = ['api-gateway-facade', 'strangler-fig', 'oauth-client-credentials'];
// Should fail: SCIM without its prerequisite trust (V1), and CDC with batch export, which CONFLICT (V2).
const PLAN = [
  { uc: 'user-provisioning', pattern: 'scim-provisioning', findings: ['f-no-scim'] },
  { uc: 'ledger-data-sync', pattern: 'cdc-replication', findings: ['f-ledger-sync'] },
  { uc: 'reporting-consolidation', pattern: 'batch-etl-export', findings: ['f-reporting'] },
];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('09-engine-ahead-of-data', () => {
  it('before: on a sparse catalog, V1 and V2 pass a plan that should fail', async () => {
    await f.rows(SPARSE, { island: ISLAND });
    await f.plan(1, PLAN);
    const r = await checks(f.driver, DEAL, 1);
    expect([r.V1.verdict, r.V2.verdict]).toEqual(['PASS', 'PASS']);
    expect(r.V7.examined - r.V7.violations.length).toBe(3);
  });

  it('after: V7 fails CI below the floor, and on the enriched catalog V1 and V2 fire', async () => {
    await f.reset();
    await f.rows(SPARSE, { island: ISLAND });
    await f.plan(1, PLAN);
    const sparse = await checks(f.driver, DEAL, 1);
    expect(sparse.V7.verdict).toBe('FAIL');
    expect(sparse.V7.coverage).toBeLessThan(coverageFloor());

    await f.reset();
    await f.plan(1, PLAN);
    const enriched = await checks(f.driver, DEAL, 1);
    expect(enriched.V7.verdict).toBe('PASS');
    expect(enriched.V1.verdict).toBe('FAIL');
    expect(enriched.V2.verdict).toBe('FAIL');
    expect(enriched.V2.violations.map((v) => v.witness)).toEqual([['batch-etl-export', 'cdc-replication']]);
  });
});
