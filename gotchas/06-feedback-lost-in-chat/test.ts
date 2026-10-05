import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { ITERATION_DIFF, reject, resolve } from './after.js';

/** Gotcha 06: feedback lost in chat. */

const COMMENT = 'Ledger sync must not read the production database log.\nremove cdc-replication';
const [FIRST, REPLAN, QUESTION] = statements(read('06-feedback-lost-in-chat', 'before.cypher')) as [string, string, string];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('06-feedback-lost-in-chat', () => {
  it('before: with feedback in a text field, "what changed since my review, and why?" cannot be answered', async () => {
    await f.rows(FIRST, { deal: DEAL });
    await f.rows(REPLAN, { deal: DEAL, comment: COMMENT });
    const rows = await f.rows(QUESTION, { deal: DEAL });
    // One state survives. The reviewed pattern is gone, and the comment is not tied to what it was about.
    expect(rows).toEqual([{ iteration: neo4j.int(1), pattern: 'event-bus-bridge', comment: COMMENT }]);
    expect(rows.some((r) => r.pattern === 'cdc-replication')).toBe(false);
    await f.reset();
  });

  it('after: Iteration + Feedback nodes, and iteration_diff answers it', async () => {
    await f.plan(1, [{ uc: 'ledger-data-sync', pattern: 'cdc-replication', score: 85.3, findings: ['f-ledger-sync'] }]);
    const rejected = await reject(f.driver, DEAL, 1, 'ledger-data-sync', COMMENT);
    expect(rejected.status).toBe('rejected');
    const [feedbackId] = rejected.feedback_ids;

    await f.plan(2, [{ uc: 'ledger-data-sync', pattern: 'event-bus-bridge', score: 84.4, findings: ['f-ledger-sync'] }]);
    await resolve(f.driver, { deal: DEAL, iteration: 2, feedback_id: feedbackId as string, resolved_by_ids: ['Selection:ledger-data-sync'] });

    expect(await f.rows(ITERATION_DIFF, { deal: DEAL, iteration: neo4j.int(2) })).toEqual([
      { uc: 'ledger-data-sync', change: 'changed', before: 'cdc-replication', after: 'event-bus-bridge', feedback: [COMMENT] },
    ]);
  });
});
