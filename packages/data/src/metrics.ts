import { nodes, relationships, type Dataset } from './types.js';

export interface Manifest {
  nodes: Record<string, number>;
  relationships: Record<string, number>;
}

const sortedCounts = (rec: Record<string, unknown[]>): Record<string, number> =>
  Object.fromEntries(
    Object.keys(rec)
      .filter((k) => (rec[k] ?? []).length > 0)
      .sort()
      .map((k) => [k, (rec[k] ?? []).length]),
  );

/** Expected node and relationship counts after a full load; the loaders check against this. */
export function manifestOf(ds: Dataset): Manifest {
  return { nodes: sortedCounts(ds.nodes), relationships: sortedCounts(ds.relationships) };
}

export const KNOWLEDGE_EDGE_TYPES = ['REQUIRES', 'CONFLICTS', 'AUGMENTS'] as const;

/** V7 at data level: share of patterns that are an endpoint of any REQUIRES/CONFLICTS/AUGMENTS edge. */
export function edgeCoverage(ds: Dataset): { covered: number; total: number; ratio: number } {
  const patterns = nodes(ds, 'Pattern').map((p) => String(p.id));
  const touched = new Set<string>();
  for (const type of KNOWLEDGE_EDGE_TYPES) {
    for (const r of relationships(ds, type)) {
      touched.add(String(r.from.key.id));
      touched.add(String(r.to.key.id));
    }
  }
  const covered = patterns.filter((p) => touched.has(p)).length;
  return { covered, total: patterns.length, ratio: patterns.length ? covered / patterns.length : 0 };
}
