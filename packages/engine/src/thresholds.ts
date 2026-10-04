import { z } from 'zod';

const unit = z.number().min(0).max(1);
const points = z.number().min(0);

/** Shape of config/thresholds.json (DESIGN §2). The engine never reads the file; callers pass the parsed value. */
export const thresholdsSchema = z
  .object({
    $comment: z.string().optional(),
    classify: z.object({ strong_evidence: z.array(z.string()).min(1), min_confidence: unit }).strict(),
    strategy: z
      .object({
        base: points,
        per_signal: points,
        absorb_coverage: unit,
        tie_break: z.enum(['bridge', 'transform']),
      })
      .strict(),
    fit: z
      .object({
        weights: z
          .object({
            use_case_match: points,
            text_overlap: points,
            strategy_compat: points,
            prereq_satisfaction: points,
            constraint_compat: points,
          })
          .strict(),
        reuse: z.object({ free_picks: z.number().int().min(0), penalty_per_pick: points }).strict(),
        bands: z.object({ recommend: points, surface: points, review: points }).strict(),
        stopwords: z.array(z.string()),
      })
      .strict(),
    provenance: z.object({ min_observations: z.number().int().positive() }).strict(),
    buy_build: z
      .object({
        rule_version: z.string().min(1),
        retire_coverage: unit,
        integrate_ratio: z.number().positive(),
        build_ratio: z.number().positive(),
      })
      .strict(),
    edge_coverage_floor: unit,
  })
  .strict();

export type Thresholds = z.infer<typeof thresholdsSchema>;
