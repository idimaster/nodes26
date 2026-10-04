import { round } from './round.js';
import type { Thresholds } from './thresholds.js';

export type Strategy = 'bridge' | 'transform';

export interface StrategyContext {
  /** Classified findings (classifyFinding already applied). */
  findings: { id: string; kind: string; severity: string; capability_type?: string | undefined }[];
  /** The acquirer's coverage per capability type (absent = 0). */
  coverage: Record<string, number>;
}

export interface StrategyRecommendation {
  strategy: Strategy;
  points: number;
  fit_score: number;
  finding_ids: string[];
  rationale: string;
}

const REASON: Record<Strategy, string> = {
  bridge: 'distinctive capabilities and high risks favor keeping the target running',
  transform: 'capabilities the acquirer platform already covers can be absorbed',
};

/** DESIGN §2.1. */
export function recommendStrategy(ctx: StrategyContext, th: Thresholds): StrategyRecommendation[] {
  const ids: Record<Strategy, string[]> = { bridge: [], transform: [] };
  for (const f of ctx.findings) {
    if (f.kind === 'capability') {
      if (f.capability_type === undefined) {
        throw new Error(`capability finding ${f.id} has no capability_type (IS_A); cannot score it`);
      }
      const coverage = ctx.coverage[f.capability_type] ?? 0;
      ids[coverage >= th.strategy.absorb_coverage ? 'transform' : 'bridge'].push(f.id);
    } else if (f.kind === 'risk' && (f.severity === 'high' || f.severity === 'critical')) {
      ids.bridge.push(f.id);
    }
  }
  const pointsOf = (s: Strategy) => th.strategy.base + th.strategy.per_signal * ids[s].length;
  const total = pointsOf('bridge') + pointsOf('transform');
  const order: Strategy[] = th.strategy.tie_break === 'bridge' ? ['bridge', 'transform'] : ['transform', 'bridge'];
  return order
    .map((strategy) => ({
      strategy,
      points: pointsOf(strategy),
      fit_score: total === 0 ? 0 : round((pointsOf(strategy) / total) * 100, 1),
      finding_ids: ids[strategy],
      rationale: `${REASON[strategy]}: ${ids[strategy].length ? ids[strategy].join(', ') : 'no findings'}`,
    }))
    .sort((a, b) => b.points - a.points); // stable: ties keep tie_break order
}
