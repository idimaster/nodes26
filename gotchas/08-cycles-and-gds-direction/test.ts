import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { earliestStarts, schedule } from './after.js';
import { naiveSchedule } from './before.js';

/** Gotcha 08: cycles and GDS direction. */

const [TASKS, PROJECT, LONGEST, DROP] = statements(read('08-cycles-and-gds-direction', 'before.cypher')) as [string, string, string, string];
const CHAIN = 1; // iteration with one pattern: a prerequisite chain of three tasks
const CYCLE = 2; // the same plan with one back edge
const num = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
  for (const iteration of [CHAIN, CYCLE]) {
    await f.plan(iteration, [{ uc: 'user-provisioning', pattern: 'scim-provisioning', findings: ['f-no-scim'] }]);
  }
  // Close the chain into a cycle in iteration 2: the first task now depends on the last.
  await f.rows(
    `MATCH (first:PlanTask {deal_code: $deal, iteration: $it}) WHERE NOT (first)-[:DEPENDS_ON]->()
     MATCH (last:PlanTask {deal_code: $deal, iteration: $it}) WHERE NOT ()-[:DEPENDS_ON]->(last)
     CREATE (first)-[:DEPENDS_ON]->(last) RETURN first.id, last.id`,
    { deal: DEAL, it: neo4j.int(CYCLE) },
  );
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

const tasks = async (iteration: number) =>
  (await f.rows(TASKS, { deal: DEAL, iteration: neo4j.int(iteration) })).map((r) => ({ id: r.id as string, weeks_e: num(r.weeks_e), deps: r.deps as string[] }));

describe('08-cycles-and-gds-direction', () => {
  it('before (a): a scheduler without a cycle check never terminates on a cycle', async () => {
    expect(naiveSchedule(await tasks(CHAIN), 10_000)).toMatchObject({ finished: true });
    const run = naiveSchedule(await tasks(CYCLE), 10_000);
    expect(run).toEqual({ finished: false, passes: 10_000, scheduled: [] });
  });

  it('after (a): the cycle check runs first and returns the witness', async () => {
    const outcome = await schedule(f.driver, DEAL, CYCLE, 'gds');
    expect(outcome.status).toBe('cycle');
    if (outcome.status === 'cycle') {
      expect(outcome.source).toBe('V3');
      expect(new Set(outcome.witness)).toEqual(new Set((await tasks(CYCLE)).map((t) => t.id)));
    }
  });

  it('before (b): a projection in DEPENDS_ON direction gives the wrong earliest starts', async () => {
    const kahn = await earliestStarts(f.driver, DEAL, CHAIN, 'kahn');
    const name = 'gotcha-08-wrong-direction';
    await f.rows(PROJECT, { deal: DEAL, iteration: neo4j.int(CHAIN), name });
    let wrong: Record<string, number>;
    try {
      wrong = Object.fromEntries((await f.rows(LONGEST, { name })).map((r) => [r.id as string, num(r.earliest_start)]));
    } finally {
      await f.rows(DROP, { name });
    }
    expect(wrong).not.toEqual(kahn);
    // The first task of the chain must start at 0; the reversed projection starts it last.
    const first = Object.entries(kahn).find(([, s]) => s === 0)?.[0] as string;
    expect(wrong[first]).toBeGreaterThan(0);
  });

  it('after (b): the flipped projection matches the Kahn parity result', async () => {
    expect(await earliestStarts(f.driver, DEAL, CHAIN, 'gds')).toEqual(await earliestStarts(f.driver, DEAL, CHAIN, 'kahn'));
  });
});
