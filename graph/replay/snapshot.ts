import neo4j, { type Driver } from 'neo4j-driver';
import { runValidators } from '../validate.js';
import type { Decision, Expectations } from './format.js';

/** What a replay must reproduce: graph counts and validator verdicts; and the architect's decisions. */

const num = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));
const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export async function expectations(driver: Driver, deal: string): Promise<Expectations> {
  const labels = await driver.executeQuery('MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS n');
  const rels = await driver.executeQuery('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n');
  const its = await driver.executeQuery('MATCH (i:Iteration {deal_code: $deal}) RETURN i.n AS n ORDER BY n', { deal });
  const verdicts: Expectations['verdicts'] = {};
  for (const r of its.records) {
    const n = num(r.get('n'));
    verdicts[String(n)] = Object.fromEntries((await runValidators(deal, n, { driver })).map((v) => [v.check, v.verdict]));
  }
  return {
    counts: sorted(Object.fromEntries(labels.records.map((r) => [r.get('label') as string, num(r.get('n'))]))),
    relationships: sorted(Object.fromEntries(rels.records.map((r) => [r.get('type') as string, num(r.get('n'))]))),
    verdicts,
  };
}

/** The decided gates of the deal. approve_except is an approval whose comment created an exclusion. */
export async function decisions(driver: Driver, deal: string): Promise<Decision[]> {
  const { records } = await driver.executeQuery(
    `MATCH (g:GateDecision {deal_code: $deal}) WHERE g.status IN ['approved', 'rejected']
     RETURN g.id AS id, g.status AS status, coalesce(g.comment, '') AS comment, coalesce(g.by, 'architect') AS by,
            EXISTS { MATCH (g)-[:CREATED]->(o:Override) WHERE o.kind IN ['exclude_pattern', 'exclude_use_case'] } AS excludes
     ORDER BY g.at, g.id`,
    { deal },
  );
  return records.map((r) => ({
    kind: 'decision',
    gate_id: r.get('id') as string,
    action: r.get('status') === 'rejected' ? 'reject' : r.get('excludes') ? 'approve_except' : 'approve',
    comment: r.get('comment') as string,
    by: r.get('by') as string,
  }));
}

/** Differences between two expectation sets, as readable lines (empty when they agree). */
export function diffExpectations(want: Expectations, got: Expectations): string[] {
  const out: string[] = [];
  const cmp = (what: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${what} ${k}: expected ${JSON.stringify(a[k] ?? null)}, got ${JSON.stringify(b[k] ?? null)}`);
    }
  };
  cmp('nodes', want.counts, got.counts);
  cmp('relationships', want.relationships, got.relationships);
  for (const it of [...new Set([...Object.keys(want.verdicts), ...Object.keys(got.verdicts)])].sort()) {
    cmp(`iteration ${it}`, want.verdicts[it] ?? {}, got.verdicts[it] ?? {});
  }
  return out;
}
