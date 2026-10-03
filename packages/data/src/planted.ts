import { z } from 'zod';
import { DATA_DIR, readYaml } from './io.js';

const id = z.string().min(1);

/** data/deals/nimbus/planted.yaml: which data realizes each planted situation (DATA.md), and the expected outcomes. */
export const plantedFile = z
  .object({
    P1: z.object({ finding: id, use_case: id, pattern: id, requires: id }).strict(),
    P2: z
      .object({
        use_cases: z
          .tuple([
            z.object({ use_case: id, finding: id, top: id, near_miss: id }).strict(),
            z.object({ use_case: id, finding: id, top: id, near_miss: id }).strict(),
          ]),
      })
      .strict(),
    P3: z.object({ finding: id, concept: z.string().regex(/^[A-Z][A-Za-z]+$/) }).strict(),
    P4: z.object({ note: z.string() }).strict(),
    P5: z.object({ finding: id, use_case: id, pattern: id }).strict(),
    P6: z.array(
      z
        .object({
          capability: id,
          finding: id,
          use_case: id,
          pattern: id,
          integrate_weeks: z.number().positive(),
          build_option: id,
          build_weeks: z.number().positive(),
          platform_capability: id,
          coverage: z.number().min(0).max(1),
          expected: z.enum(['integrate', 'retire', 'review']),
        })
        .strict(),
    ),
  })
  .strict();

export type Planted = z.infer<typeof plantedFile>;

export const readPlanted = (dir = DATA_DIR): Planted => readYaml(dir, 'deals/nimbus/planted.yaml', plantedFile);
