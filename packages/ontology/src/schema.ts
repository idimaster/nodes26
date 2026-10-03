import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/);
const prop = z.string().regex(/^[a-z][a-z0-9_]*$/);
const relType = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const labelSchema = z
  .object({
    name,
    subgraph: z.enum(['knowledge', 'evidence', 'plan', 'decisions', 'meta']),
    key: z.array(prop).min(1),
    required: z.array(prop),
    enums: z.record(prop, z.array(z.string()).min(1)),
    perDeal: z.boolean(),
    /** Property holding the deal code on per-deal labels (`code` on Deal, `deal_code` elsewhere). */
    dealProperty: prop.optional(),
    reserved: z.boolean(),
  })
  .strict();

export const relationshipSchema = z
  .object({
    type: relType,
    endpoints: z.array(z.object({ from: z.array(name).min(1), to: z.array(name).min(1) }).strict()).min(1),
    properties: z.array(prop),
  })
  .strict();

export const ontologyFileSchema = z
  .object({
    $comment: z.string().optional(),
    version: z.number().int().positive(),
    labels: z.array(labelSchema).min(1),
    relationships: z.array(relationshipSchema).min(1),
  })
  .strict();

export type LabelDef = z.infer<typeof labelSchema>;
export type RelationshipDef = z.infer<typeof relationshipSchema>;
export type OntologyFile = z.infer<typeof ontologyFileSchema>;

/** Cross-reference checks zod can't express. Returns human-readable problems; empty means consistent. */
export function checkConsistency(o: OntologyFile): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const l of o.labels) {
    if (names.has(l.name)) problems.push(`duplicate label ${l.name}`);
    names.add(l.name);
    const props = new Set([...l.key, ...l.required]);
    if (props.size !== l.key.length + l.required.length) problems.push(`${l.name}: a property is listed twice`);
    for (const p of Object.keys(l.enums)) {
      if (!props.has(p)) problems.push(`${l.name}: enum on ${p}, which is not a key or required property`);
    }
    if (l.perDeal !== (l.dealProperty !== undefined)) {
      problems.push(`${l.name}: dealProperty must be set exactly when perDeal is true`);
    }
    if (l.dealProperty !== undefined && !props.has(l.dealProperty)) {
      problems.push(`${l.name}: dealProperty ${l.dealProperty} is not a key or required property`);
    }
  }
  const types = new Set<string>();
  for (const r of o.relationships) {
    if (types.has(r.type)) problems.push(`duplicate relationship type ${r.type}`);
    types.add(r.type);
    for (const e of r.endpoints) {
      for (const n of [...e.from, ...e.to]) {
        if (!names.has(n)) problems.push(`${r.type}: endpoint references unknown label ${n}`);
      }
    }
  }
  return problems;
}
