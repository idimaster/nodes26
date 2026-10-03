import type { OntologyFile } from './schema.js';

export function snake(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** DDL for DESIGN §1.4: one uniqueness constraint per key, one deal_code index per per-deal label. */
export function buildSchemaStatements(o: OntologyFile): string[] {
  const constraints = o.labels.map((l) => {
    const props = l.key.map((p) => `n.${p}`);
    const target = props.length === 1 ? props[0] : `(${props.join(', ')})`;
    return `CREATE CONSTRAINT ${snake(l.name)}_key IF NOT EXISTS FOR (n:${l.name}) REQUIRE ${target} IS UNIQUE`;
  });
  const indexes = o.labels
    .filter((l) => l.dealProperty === 'deal_code')
    .map((l) => `CREATE INDEX ${snake(l.name)}_deal_code IF NOT EXISTS FOR (n:${l.name}) ON (n.deal_code)`);
  return [...constraints, ...indexes];
}

export function buildSchemaCypher(o: OntologyFile): string {
  const header = [
    '// GENERATED from config/ontology.json by `npm run schema:gen`. Do not edit by hand.',
    '// Applied one statement at a time by graph/apply-schema.ts. Idempotent (IF NOT EXISTS).',
    '',
  ];
  return header.join('\n') + buildSchemaStatements(o).map((s) => `${s};\n`).join('');
}
