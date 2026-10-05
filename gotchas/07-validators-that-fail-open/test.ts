import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { validator } from './after.js';

/** Gotcha 07: validators that fail open. */

const FOLDER = '07-validators-that-fail-open';
const [WRONG_SCHEMA, TRACK_FALLBACK] = statements(read(FOLDER, 'before.cypher')) as [string, string];
const [FAIL_CLOSED] = statements(read(FOLDER, 'after.cypher')) as [string];
const it1 = { deal: DEAL, iteration: neo4j.int(1) };
const it2 = { deal: DEAL, iteration: neo4j.int(2) };
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
  // Iteration 1, P2: two selected patterns that CONFLICT.
  await f.plan(1, [
    { uc: 'ledger-data-sync', pattern: 'cdc-replication', findings: ['f-ledger-sync'] },
    { uc: 'reporting-consolidation', pattern: 'batch-etl-export', findings: ['f-reporting'] },
  ]);
  // Iteration 2, P1: the critical gap is framed into user-provisioning, which is scored but not selected;
  // another identity-track pattern is selected for a different use case.
  await f.plan(2, [
    { uc: 'user-provisioning', pattern: 'scim-provisioning', findings: ['f-no-scim'], select: false },
    { uc: 'identity-federation-trust', pattern: 'idp-trust-establishment', findings: ['f-customer-sso'] },
  ]);
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('07-validators-that-fail-open', () => {
  it('before (a): a validator on the wrong schema returns 0 rows, which reads as PASS', async () => {
    expect(await f.rows(WRONG_SCHEMA, it1)).toEqual([]);
  });

  it('after (a): the examined count turns it into "FAIL: nothing checked"; the real V2 reports the conflict', async () => {
    expect(await f.rows(FAIL_CLOSED, it1)).toEqual([{ examined: neo4j.int(0), verdict: 'FAIL: nothing checked' }]);
    const v2 = await validator(f.driver, DEAL, 1, 'V2');
    expect(v2.verdict).toBe('FAIL');
    expect(v2.violations.map((v) => v.witness)).toEqual([['batch-etl-export', 'cdc-replication']]);
  });

  it('before (b): a track-level fallback marks the uncovered critical gap as covered', async () => {
    // It does detect the gap when nothing at all is selected (an iteration without a plan)...
    expect(await f.rows(TRACK_FALLBACK, { deal: DEAL, iteration: neo4j.int(9) })).toEqual([{ uncovered: 'f-no-scim' }]);
    // ...but in iteration 2 an unrelated identity-track selection "covers" it.
    expect(await f.rows(TRACK_FALLBACK, it2)).toEqual([]);
  });

  it('after (b): V4 with exact provenance reports the gap', async () => {
    const v4 = await validator(f.driver, DEAL, 2, 'V4');
    expect(v4.verdict).toBe('FAIL');
    expect(v4.violations.map((v) => v.witness)).toEqual([['f-no-scim']]);
  });
});
