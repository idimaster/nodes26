import { z } from 'zod';

/** Schemas for the hand-authored YAML files under data/. Strict: unknown fields are errors. */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const text = z.string().min(1);
const unit = z.number().min(0).max(1);
const weeks = z
  .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
  .refine(([o, e, p]) => o <= e && e <= p, 'weeks must be [optimistic <= expected <= pessimistic]');
const skill = z.enum(['identity', 'platform', 'data', 'security', 'frontend', 'ops']);
const strategy = z.enum(['bridge', 'transform']);

export const strategiesFile = z.array(z.object({ id: strategy, description: text }).strict());
export const tracksFile = z.array(z.object({ id, name: text, order: z.number().int().positive() }).strict());
export const useCasesFile = z.array(z.object({ id, display: text, description: text }).strict());
export const capabilityTypesFile = z.array(z.object({ id, name: text }).strict());

export const buildOptionsFile = z.array(
  z.object({ id, delivers: id, weeks, confidence: unit, source: text }).strict(),
);

export const platformCapabilitiesFile = z.array(
  z
    .object({
      id,
      name: text,
      provides: z.array(z.object({ capability: id, coverage: unit }).strict()).min(1),
    })
    .strict(),
);

export const patternTask = z
  .object({
    id,
    summary: text,
    weeks,
    skill,
    depends_on: z.array(id).default([]),
  })
  .strict();

export const patternsFile = z.array(
  z
    .object({
      id,
      name: text,
      description: text,
      track: id,
      reference: text,
      strategies: z.array(strategy).min(1),
      solves: z.array(id).min(1),
      requires: z.array(id).default([]),
      conflicts: z.array(id).default([]),
      augments: z.array(id).default([]),
      supersedes: z.array(id).default([]),
      not_recommended_when: z.array(text).default([]),
      tasks: z.array(patternTask).min(2),
    })
    .strict(),
);

export const findingKind = z.enum(['capability', 'gap', 'risk', 'assumption', 'service']);
export const severity = z.enum(['critical', 'high', 'medium', 'low']);
export const evidenceType = z.enum(['code_inspection', 'vendor_docs', 'rfi', 'interview', 'assumption']);

export const findingEntry = z
  .object({
    id,
    kind: findingKind,
    text,
    severity,
    confidence: unit,
    evidence_type: evidenceType,
    sources: z.array(id).min(1),
    is_a: id.optional(),
    calls: z.array(id).default([]),
  })
  .strict();

export const dealFile = z
  .object({
    deal: z
      .object({
        code: id,
        target_company: text,
        acquirer: text,
        strategy: z.enum(['pending', 'bridge', 'transform']),
        status: z.enum(['active', 'completed']),
      })
      .strict(),
    sources: z.array(z.object({ id, type: text, uri: text }).strict()),
    findings: z.array(findingEntry),
  })
  .strict();

export const historyFile = z
  .object({
    deals: z.array(
      z
        .object({
          code: id,
          target_company: text,
          acquirer: text,
          strategy,
          started_at: z.iso.datetime(),
          selections: z.array(z.object({ use_case: id, pattern: id }).strict()).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type PatternEntry = z.infer<typeof patternsFile>[number];
export type FindingEntry = z.infer<typeof findingEntry>;
export type HistoryDeal = z.infer<typeof historyFile>['deals'][number];
