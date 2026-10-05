import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { runValidators } from '../../../../graph/validate.js';
import { plain, readQuery } from './read.js';

/**
 * Provider seams (T4.2 addendum §5.3). Since M3 has landed, every default is the real implementation;
 * the seams stay so the page never depends on how a table or witness is computed.
 */

export interface WitnessProvider {
  latest(deal: string, iteration: number, version: string): Promise<{ check: string; eids: string[] } | null>;
}

export type TableName = 'buy_vs_build' | 'resource_load' | 'validators' | 'iteration_diff';
export type TableResult = { status: 'ok'; columns: string[]; rows: unknown[][] } | { status: 'unavailable'; reason: string };

export interface TableProvider {
  name: TableName;
  get(deal: string, iteration: number): Promise<TableResult>;
}

const query = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const RESOURCE_LOAD = query('../../../../graph/queries/resource-load.cypher');
const ITERATION_DIFF = query('../../../../graph/queries/skill/iteration_diff.cypher');

/** The first failing validator's witnesses. Runs only when the scene version changes, never on every poll. */
export function validatorWitness(driver: Driver): WitnessProvider {
  const cache = new Map<string, { check: string; eids: string[] } | null>();
  return {
    async latest(deal, iteration, version) {
      const key = `${deal}/${iteration}/${version}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      const results = await runValidators(deal, iteration, { driver, checks: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'] });
      const failing = results.find((r) => r.verdict === 'FAIL');
      const witness = failing ? { check: failing.check, eids: [...new Set(failing.violations.flatMap((v) => v.witness_eids))] } : null;
      cache.clear();
      cache.set(key, witness);
      return witness;
    },
  };
}

const table = (columns: string[], rows: unknown[][]): TableResult => ({ status: 'ok', columns, rows });

export function tableProviders(driver: Driver): TableProvider[] {
  const args = (deal: string, iteration: number) => ({ deal, iteration: neo4j.int(iteration) });
  return [
    {
      name: 'buy_vs_build',
      async get(deal, iteration) {
        const rows = await readQuery(
          driver,
          `MATCH (c:CapabilityDecision {deal_code: $deal, iteration: $iteration})
           RETURN c.capability_id AS capability, c.outcome AS outcome, c.integrate_effort AS integrate,
                  c.build_effort AS build, c.coverage AS coverage, c.rule_version AS rule
           ORDER BY capability`,
          args(deal, iteration),
        );
        if (rows.length === 0) return { status: 'unavailable', reason: 'no decisions yet' };
        return table(['capability', 'outcome', 'integrate (wk)', 'build (wk)', 'coverage', 'rule'], rows.map((r) => [...r.values()].map(plain)));
      },
    },
    {
      name: 'resource_load',
      async get(deal, iteration) {
        const rows = await readQuery(driver, RESOURCE_LOAD, args(deal, iteration));
        if (rows.length === 0) return { status: 'unavailable', reason: 'not scheduled yet' };
        return table(['skill', 'wave', 'weeks', 'tasks'], rows.map((r) => [...r.values()].map(plain)));
      },
    },
    {
      name: 'validators',
      async get(deal, iteration) {
        const results = await runValidators(deal, iteration, { driver });
        return table(['check', 'examined', 'verdict'], results.map((r) => [r.check, r.examined, r.verdict]));
      },
    },
    {
      name: 'iteration_diff',
      async get(deal, iteration) {
        if (iteration < 2) return { status: 'unavailable', reason: 'needs iteration 2' };
        const rows = await readQuery(driver, ITERATION_DIFF, args(deal, iteration));
        return table(['use case', 'change', 'before', 'after', 'feedback'], rows.map((r) => [...r.values()].map(plain)));
      },
    },
  ];
}
