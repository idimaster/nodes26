import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAL, fixture, read, statements, type Fixture } from '../_shared/fixture.js';
import { guardDecision } from './after.js';

/** Gotcha 02: prompt rules are not guardrails. */

const [UNBOUNDED, NO_DEAL, DELETE] = statements(read('02-prompt-rules-are-not-guardrails', 'before.cypher')) as [string, string, string];
let f: Fixture;

beforeAll(async () => {
  f = await fixture();
  await f.reset();
  // The history deals already have iteration-1 selections, so the unscoped edit visibly crosses deals.
  await f.plan(1, [{ uc: 'identity-federation-trust', pattern: 'idp-trust-establishment', findings: ['f-no-scim'] }]);
});
afterAll(async () => {
  await f.reset();
  await f.close();
});

describe('02-prompt-rules-are-not-guardrails', () => {
  it('before: the unbounded path, the write without $deal, and DETACH DELETE all execute', async () => {
    expect((await f.rows(UNBOUNDED, { deal: DEAL }))[0]?.paths).toBeDefined();
    await f.rows(NO_DEAL);
    const touched = await f.rows("MATCH (s:Selection {iteration: 1, rationale: 'bulk edit'}) RETURN DISTINCT s.deal_code AS deal ORDER BY deal");
    expect(touched.map((r) => r.deal)).toEqual(['nimbus', 'quarry', 'tidewater']);
    expect(Number((await f.rows(DELETE, { deal: DEAL }))[0]?.deleted)).toBe(1);
    expect(await f.rows("MATCH (x:Finding {deal_code: 'nimbus', id: 'f-weak-mfa'}) RETURN x")).toEqual([]);
  });

  it('after: the guard denies each one, with a reason that names the rule and the fix', async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [UNBOUNDED, { deal: DEAL }, /G4: .*bound/i],
      [NO_DEAL, { deal: DEAL }, /G5: .*\$deal/],
      [DELETE, { deal: DEAL }, /G2: .*DELETE/i],
    ];
    for (const [query, params, reason] of cases) {
      const decision = await guardDecision(f.driver, query, params);
      expect(decision.allow, query).toBe(false);
      if (!decision.allow) expect(decision.reason).toMatch(reason);
    }
  });
});
