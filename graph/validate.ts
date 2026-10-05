import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { openDriver } from './connection.js';

/**
 * Validators V1–V7 (DESIGN §5.1). Each graph/queries/validators/*.cypher returns exactly one row:
 * {check, examined, violations: [{witness, witness_eids, detail}], verdict}, and V7 also returns coverage.
 * examined = 0 is "FAIL: nothing checked", never a pass (gotcha 07a).
 */

export const VALIDATORS_DIR = fileURLToPath(new URL('./queries/validators', import.meta.url));
const THRESHOLDS = fileURLToPath(new URL('../config/thresholds.json', import.meta.url));

export type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'FAIL: nothing checked';

export interface Violation {
  /** Domain ids: pattern, task, finding, or selection use-case ids. */
  witness: string[];
  /** elementId() of each witness node, in the same order (for the UI). */
  witness_eids: string[];
  detail: string;
}

export interface ValidatorResult {
  check: string;
  examined: number;
  violations: Violation[];
  verdict: Verdict;
  /** V7 only: the share of patterns with a knowledge edge. */
  coverage?: number;
}

export interface ValidatorFile {
  check: string;
  file: string;
  query: string;
}

/** Validator files in check order (v1 … v6, v6b, v7). The check name comes from the file's RETURN. */
export const VALIDATOR_FILES: ValidatorFile[] = readdirSync(VALIDATORS_DIR)
  .filter((f) => f.endsWith('.cypher'))
  .sort()
  .map((file) => {
    const query = readFileSync(join(VALIDATORS_DIR, file), 'utf8');
    const check = /RETURN '(V[0-9]+b?)' AS check/.exec(query)?.[1];
    if (!check) throw new Error(`${file}: no "RETURN 'Vn' AS check"`);
    return { check, file, query };
  });

const num = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));

export function coverageFloor(): number {
  const th = JSON.parse(readFileSync(THRESHOLDS, 'utf8')) as { edge_coverage_floor?: unknown };
  if (typeof th.edge_coverage_floor !== 'number') throw new Error('config/thresholds.json has no edge_coverage_floor');
  return th.edge_coverage_floor;
}

/**
 * Runs the validators for one deal and iteration (exported for the UI's providers, T4.2 addendum A1).
 * Opens its own driver unless one is given.
 */
export async function runValidators(
  deal: string,
  iteration: number,
  opts: { driver?: Driver; floor?: number; checks?: string[] } = {},
): Promise<ValidatorResult[]> {
  const driver = opts.driver ?? openDriver();
  const floor = opts.floor ?? coverageFloor();
  try {
    const results: ValidatorResult[] = [];
    for (const v of VALIDATOR_FILES) {
      if (opts.checks && !opts.checks.includes(v.check)) continue;
      const { records } = await driver.executeQuery(
        v.query,
        { deal, iteration: neo4j.int(iteration), floor },
        { routing: neo4j.routing.READ },
      );
      if (records.length !== 1) throw new Error(`${v.file} returned ${records.length} rows; a validator must return exactly one`);
      const r = records[0] as (typeof records)[number];
      const result: ValidatorResult = {
        check: r.get('check') as string,
        examined: num(r.get('examined')),
        violations: r.get('violations') as Violation[],
        verdict: r.get('verdict') as Verdict,
      };
      if (r.has('coverage')) result.coverage = num(r.get('coverage'));
      results.push(result);
    }
    return results;
  } finally {
    if (!opts.driver) await driver.close();
  }
}

/** Failing results (FAIL or FAIL: nothing checked); WARN does not fail. */
export const failures = (results: ValidatorResult[]) => results.filter((r) => r.verdict.startsWith('FAIL'));

async function main(): Promise<void> {
  const [deal, iteration] = process.argv.slice(2);
  if (!deal || !iteration || !/^[1-9][0-9]*$/.test(iteration)) {
    console.error('usage: npm run validate -- <deal> <iteration>');
    process.exit(2);
  }
  const results = await runValidators(deal, Number(iteration));
  for (const r of results) {
    console.log(`${r.check.padEnd(4)} ${r.verdict.padEnd(22)} examined ${String(r.examined).padStart(3)}${r.coverage !== undefined ? `  coverage ${r.coverage.toFixed(2)}` : ''}`);
    for (const v of r.violations) console.log(`       ${v.detail}  [${v.witness.join(' → ')}]`);
  }
  if (failures(results).length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
