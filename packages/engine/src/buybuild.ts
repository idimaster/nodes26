import type { Thresholds } from './thresholds.js';

export interface BuyBuildRow {
  capability_id: string;
  /** Null when no Selection covers the capability finding. */
  integrate_effort: number | null;
  build_effort: number;
  coverage: number;
}

export type BuyBuildOutcome = 'integrate' | 'build' | 'retire' | 'review';

export interface BuyBuildDecision {
  capability_id: string;
  outcome: BuyBuildOutcome;
  /** 1-based number of the rule that matched (DESIGN §2.6). */
  rule: 1 | 2 | 3 | 4;
  integrate_effort: number;
  build_effort: number;
  coverage: number;
}

/** DESIGN §2.6 (bb1): first matching rule wins. */
export function classifyBuyBuild(
  rows: BuyBuildRow[],
  th: Thresholds,
): { rule_version: string; outcomes: BuyBuildDecision[]; unplanned: string[] } {
  const t = th.buy_build;
  const outcomes: BuyBuildDecision[] = [];
  const unplanned: string[] = [];
  for (const r of rows) {
    if (r.integrate_effort === null) {
      unplanned.push(r.capability_id);
      continue;
    }
    const decide = (outcome: BuyBuildOutcome, rule: BuyBuildDecision['rule']): BuyBuildDecision => ({
      capability_id: r.capability_id,
      outcome,
      rule,
      integrate_effort: r.integrate_effort as number,
      build_effort: r.build_effort,
      coverage: r.coverage,
    });
    if (r.coverage >= t.retire_coverage) outcomes.push(decide('retire', 1));
    else if (r.integrate_effort <= t.integrate_ratio * r.build_effort) outcomes.push(decide('integrate', 2));
    else if (r.build_effort <= t.build_ratio * r.integrate_effort) outcomes.push(decide('build', 3));
    else outcomes.push(decide('review', 4));
  }
  return { rule_version: t.rule_version, outcomes, unplanned };
}
