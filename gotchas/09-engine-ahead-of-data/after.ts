import type { Driver } from 'neo4j-driver';
import { coverageFloor, runValidators, type ValidatorResult } from '../../graph/validate.js';

/**
 * After: V7, the knowledge-edge coverage check (`npm run coverage:edges` in CI), fails when fewer than
 * `edge_coverage_floor` (config/thresholds.json) of the catalog patterns have any knowledge edge.
 * With the enriched catalog, V1 and V2 fire on the same plan.
 */
export async function checks(driver: Driver, deal: string, iteration: number) {
  const results = await runValidators(deal, iteration, { driver, checks: ['V1', 'V2', 'V7'] });
  return Object.fromEntries(results.map((r) => [r.check, r])) as Record<'V1' | 'V2' | 'V7', ValidatorResult>;
}

export { coverageFloor };
