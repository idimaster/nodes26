import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { alternativesWithin20 } from './after.js';

/** Gotcha 04: the graph as an index. */

const [INDEX_ONLY] = statements(read('04-graph-as-index', 'before.cypher')) as [string];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('04-graph-as-index', () => {
  it('before: a Selection that only stores file_path cannot answer "alternatives within 20 points?"', async () => {
    expect(await f.rows(INDEX_ONLY, { deal: DEAL, iteration: 1 })).toEqual([{ file_path: 'plans/nimbus/ledger-data-sync.md' }]);
    expect(await alternativesWithin20(f.driver, DEAL, 1, 'ledger-data-sync')).toEqual([]);
  });

  it('after: Selection + Candidate nodes answer it in one query', async () => {
    await f.plan(2, [
      {
        uc: 'ledger-data-sync',
        pattern: 'event-bus-bridge',
        score: 84.4,
        findings: ['f-ledger-sync'],
        alternatives: [['cdc-replication', 85.3], ['batch-etl-export', 70], ['bulk-migration', 50]],
      },
    ]);
    expect(await alternativesWithin20(f.driver, DEAL, 2, 'ledger-data-sync')).toEqual([
      { pattern: 'cdc-replication', fit_score: 85.3 },
      { pattern: 'batch-etl-export', fit_score: 70 },
    ]);
  });
});
