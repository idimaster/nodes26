import raw from '../../../config/ontology.json' with { type: 'json' };
import { buildSchemaCypher, buildSchemaStatements } from './ddl.js';
import { checkConsistency, ontologyFileSchema, type LabelDef, type OntologyFile } from './schema.js';

export { checkConsistency, ontologyFileSchema };
export type { LabelDef, OntologyFile, PropertyType, RelationshipDef } from './schema.js';
export { snake } from './ddl.js';

function load(): OntologyFile {
  const parsed = ontologyFileSchema.parse(raw);
  const problems = checkConsistency(parsed);
  if (problems.length > 0) {
    throw new Error(`config/ontology.json is inconsistent:\n- ${problems.join('\n- ')}`);
  }
  return parsed;
}

/** The validated core ontology. Throws at import time if config/ontology.json is invalid. */
export const ontology: OntologyFile = load();

export const labelNames = (): string[] => ontology.labels.map((l) => l.name);
export const relationshipTypes = (): string[] => ontology.relationships.map((r) => r.type);
export const reservedLabels = (): string[] => ontology.labels.filter((l) => l.reserved).map((l) => l.name);
export const perDealLabels = (): LabelDef[] => ontology.labels.filter((l) => l.perDeal);
export const label = (name: string): LabelDef | undefined => ontology.labels.find((l) => l.name === name);

export const schemaStatements = (): string[] => buildSchemaStatements(ontology);
export const renderSchemaCypher = (): string => buildSchemaCypher(ontology);
