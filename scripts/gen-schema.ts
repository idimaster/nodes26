import { writeFileSync } from 'node:fs';
import { renderSchemaCypher } from '@planner/ontology';
import { SCHEMA_FILE } from '../graph/apply-schema.js';

writeFileSync(SCHEMA_FILE, renderSchemaCypher());
console.log('schema:gen: wrote graph/schema.cypher');
