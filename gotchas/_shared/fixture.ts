import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { cypherTemplate, templateParams, type TemplateName } from '@planner/engine';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/**
 * Shared fixture for the gotcha folders (GOTCHAS.md): the demo graph, the agent's templates, and the
 * Cypher files of a folder. Nothing here re-implements planner logic; the "after" side of every gotcha
 * imports the real guard, ontology server, validators, scheduler, or tool-surface check.
 */

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEAL = 'nimbus';

export interface Pick {
  uc: string;
  pattern: string;
  findings: string[];
  score?: number;
  alternatives?: [string, number][];
  /** false: frame the use case and score its candidates, but select nothing for it. */
  select?: boolean;
}

export interface Fixture {
  driver: Driver;
  run: (name: TemplateName, params: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  rows: (query: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  plan: (iteration: number, picks: Pick[]) => Promise<void>;
  /** Wipes the graph and reloads the demo data (schema, catalog, deals, history). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Reads `gotchas/<folder>/<file>`. Cypher files may hold several statements separated by `;` lines. */
export const read = (folder: string, file: string) => readFileSync(join(ROOT, 'gotchas', folder, file), 'utf8');
export const statements = (text: string) =>
  text
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*\/\/.*$/gm, '').trim())
    .filter(Boolean);

export async function fixture(): Promise<Fixture> {
  const driver = openDriver();
  const rows: Fixture['rows'] = async (query, params = {}) => (await driver.executeQuery(query, params)).records.map((r) => r.toObject());
  const run: Fixture['run'] = async (name, params) => rows(cypherTemplate(name).query, templateParams(name, params));
  const reset = async () => {
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await loadAll(driver);
  };
  const plan: Fixture['plan'] = async (iteration, picks) => {
    await run('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
    await run('write_framed_use_cases', {
      deal: DEAL,
      iteration,
      rows: picks.map((p) => ({ use_case_id: p.uc, framing_rationale: `Framed from ${p.findings.join(', ')}.`, finding_ids: p.findings })),
    });
    await run('write_candidates', {
      deal: DEAL,
      iteration,
      rows: picks.flatMap((p) => [
        { uc: p.uc, pattern: p.pattern, fit_score: p.score ?? 80, band: 'recommend', signal_snapshot: '{}' },
        ...(p.alternatives ?? []).map(([pattern, score]) => ({ uc: p.uc, pattern, fit_score: score, band: 'surface', signal_snapshot: '{}' })),
      ]),
    });
    const selected = picks.filter((p) => p.select !== false);
    if (selected.length > 0) {
      await run('write_selections', {
        deal: DEAL,
        iteration,
        rows: selected.map((p) => ({ uc: p.uc, pattern: p.pattern, fit_score: p.score ?? 80, rationale: 'Top pick.' })),
      });
      await run('write_plan_tasks', { deal: DEAL, iteration });
    }
  };
  return { driver, run, rows, plan, reset, close: () => driver.close() };
}
