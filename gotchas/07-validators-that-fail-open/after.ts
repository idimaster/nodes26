import type { Driver } from 'neo4j-driver';
import { runValidators, type ValidatorResult } from '../../graph/validate.js';

/**
 * After: the real validators. V2 (conflicts) on the real schema, and V4 (critical-gap coverage) with exact
 * provenance only: Finding <-FRAMED_FROM- FramedUseCase <-FOR- Selection, no track or use-case fallback.
 */
export async function validator(driver: Driver, deal: string, iteration: number, check: 'V2' | 'V4'): Promise<ValidatorResult> {
  const [result] = await runValidators(deal, iteration, { driver, checks: [check] });
  if (!result) throw new Error(`validator ${check} is missing`);
  return result;
}
