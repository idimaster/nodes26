import { round } from './round.js';
import type { Thresholds } from './thresholds.js';

export interface Modifier {
  name: string;
  factor: number;
}

export interface Provenance {
  task_id: string;
  baseline: number;
  history_avg: number | null;
  n: number;
  modifiers: Modifier[];
  result: number;
  band: [number, number];
}

/** DESIGN §2.4: baseline, blended with history, times modifiers. */
export function estimateProvenance(
  input: {
    task: { id: string; weeks_o: number; weeks_e: number; weeks_p: number };
    observations: number[];
    modifiers: Modifier[];
  },
  th: Thresholds,
): Provenance {
  const { task, observations, modifiers } = input;
  const baseline = task.weeks_e;
  if (!(baseline > 0)) throw new Error(`task ${task.id} has no positive weeks_e baseline`);
  const n = observations.length;
  const avg = n === 0 ? null : observations.reduce((s, x) => s + x, 0) / n;
  const blended =
    avg === null ? baseline : n >= th.provenance.min_observations ? avg : (baseline + n * avg) / (1 + n);
  const result = round(modifiers.reduce((x, m) => x * m.factor, blended), 1);
  return {
    task_id: task.id,
    baseline,
    history_avg: avg === null ? null : round(avg, 2),
    n,
    modifiers,
    result,
    band: [round((task.weeks_o * result) / baseline, 1), round((task.weeks_p * result) / baseline, 1)],
  };
}
