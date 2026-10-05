import neo4j, { type Driver, type Record as Neo4jRecord } from 'neo4j-driver';

/** Every UI read runs in a READ session with a 2-second transaction timeout (T4.2 addendum, Step 3). */
export async function readQuery(driver: Driver, query: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    return await session.executeRead(async (tx) => (await tx.run(query, params)).records, { timeout: 2000 });
  } finally {
    await session.close();
  }
}

export const toNum = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : v);

/** Plain JSON values from driver values (integers, temporal types). */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return (v as { toNumber(): number }).toNumber();
  if (Array.isArray(v)) return v.map(plain);
  if (neo4j.isDateTime(v) || neo4j.isDate(v) || neo4j.isLocalDateTime(v) || neo4j.isTime(v) || neo4j.isLocalTime(v) || neo4j.isDuration(v)) {
    return String(v);
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  return v;
}
