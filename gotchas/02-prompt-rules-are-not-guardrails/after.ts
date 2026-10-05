import type { Driver } from 'neo4j-driver';
import { loadContext, validate, type Decision } from '@planner/guard';

/** After: the same statements go through the write guard (the PreToolUse hook on write-cypher), which denies each one. */
export const guardDecision = async (driver: Driver, query: string, params: Record<string, unknown>): Promise<Decision> =>
  validate(query, params, await loadContext(driver, params.deal as string));
