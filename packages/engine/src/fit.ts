import { round } from './round.js';
import type { Thresholds } from './thresholds.js';

export interface FitCandidate {
  id: string;
  name: string;
  description: string;
  /** UseCase ids the pattern SOLVES. */
  solves: string[];
  /** Strategies the pattern APPLIES_TO. */
  strategies: string[];
  /** Pattern ids the pattern REQUIRES. */
  requires: string[];
  not_recommended_when: string[];
}

export interface FitInput {
  use_case: { use_case_id: string; description: string; finding_texts: string[] };
  deal_context: {
    strategy: string;
    target_company: string;
    acquirer: string;
    /** Pattern of every Selection already in this iteration (repeats count for reuse). */
    selected_patterns: string[];
    /** Rules from not_recommended_when that apply to this deal, per pattern (proposed by the LLM). */
    flagged_rules?: Record<string, string[]> | undefined;
  };
  candidates: FitCandidate[];
}

export type Band = 'recommend' | 'surface' | 'review' | 'hidden';

export interface FitAnalysis {
  pattern: string;
  score: number;
  band: Band;
  signals: {
    use_case_match: number;
    text_overlap: number;
    strategy_compat: number;
    prereq_satisfaction: number;
    constraint_compat: number;
  };
  reuse_penalty: number;
  flags: string[];
}

export function tokenize(text: string, th: Thresholds, names: string[] = []): Set<string> {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const drop = new Set([...th.fit.stopwords, ...names.flatMap(words)]);
  return new Set(words(text).filter((w) => w.length >= 3 && !drop.has(w)));
}

export function bandFor(score: number, th: Thresholds): Band {
  if (score >= th.fit.bands.recommend) return 'recommend';
  if (score >= th.fit.bands.surface) return 'surface';
  if (score >= th.fit.bands.review) return 'review';
  return 'hidden';
}

/** DESIGN §2.2 (Option B). */
export function analyzePatternFit(input: FitInput, th: Thresholds): FitAnalysis[] {
  const w = th.fit.weights;
  const ctx = input.deal_context;
  const names = [ctx.target_company, ctx.acquirer];
  const context = tokenize([input.use_case.description, ...input.use_case.finding_texts].join(' '), th, names);
  const selected = new Set(ctx.selected_patterns);

  return input.candidates
    .map((c): FitAnalysis => {
      const own = tokenize(`${c.name} ${c.description}`, th, names);
      const shared = [...own].filter((t) => context.has(t)).length;
      const flags = [...new Set(ctx.flagged_rules?.[c.id] ?? [])].filter((r) => c.not_recommended_when.includes(r));
      const signals = {
        use_case_match: c.solves.includes(input.use_case.use_case_id) ? w.use_case_match : 0,
        text_overlap: own.size === 0 ? 0 : (w.text_overlap * shared) / own.size,
        strategy_compat: c.strategies.includes(ctx.strategy) ? w.strategy_compat : 0,
        prereq_satisfaction:
          c.requires.length === 0
            ? w.prereq_satisfaction
            : (w.prereq_satisfaction * c.requires.filter((r) => selected.has(r)).length) / c.requires.length,
        constraint_compat:
          c.not_recommended_when.length === 0
            ? w.constraint_compat
            : w.constraint_compat * (1 - flags.length / c.not_recommended_when.length),
      };
      const nthUse = ctx.selected_patterns.filter((p) => p === c.id).length + 1;
      const reuse_penalty = th.fit.reuse.penalty_per_pick * Math.max(0, nthUse - th.fit.reuse.free_picks);
      const raw = Object.values(signals).reduce((s, x) => s + x, 0) - reuse_penalty;
      const score = round(Math.min(100, Math.max(0, raw)), 1);
      return {
        pattern: c.id,
        score,
        band: bandFor(score, th),
        signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, round(v, 2)])) as FitAnalysis['signals'],
        reuse_penalty,
        flags,
      };
    })
    .sort((a, b) => b.score - a.score || (a.pattern < b.pattern ? -1 : 1));
}
