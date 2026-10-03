import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkConsistency,
  ontology,
  ontologyFileSchema,
  perDealLabels,
  renderSchemaCypher,
  reservedLabels,
  schemaStatements,
} from '../src/index.js';

describe('ontology accessors', () => {
  it('lists the reserved labels from CLAUDE.md', () => {
    expect(reservedLabels().sort()).toEqual(['Actual', 'Feedback', 'GateDecision', 'OntologyTerm', 'Override']);
  });

  it('marks Deal as per-deal by its code, everything else per-deal by deal_code', () => {
    const perDeal = perDealLabels();
    expect(perDeal.find((l) => l.name === 'Deal')?.dealProperty).toBe('code');
    expect(perDeal.filter((l) => l.dealProperty === 'deal_code')).toHaveLength(13);
  });
});

describe('consistency checks', () => {
  const base = ontologyFileSchema.parse(structuredClone(ontology));

  it('accepts the shipped ontology', () => {
    expect(checkConsistency(base)).toEqual([]);
  });

  it('rejects an endpoint that names an unknown label', () => {
    const bad = structuredClone(base);
    bad.relationships[0]!.endpoints[0]!.to = ['Nope'];
    expect(checkConsistency(bad)).toContainEqual(expect.stringContaining('unknown label Nope'));
  });

  it('rejects an enum on a property that is not required or key', () => {
    const bad = structuredClone(base);
    bad.labels[0]!.enums = { ghost: ['a'] };
    expect(checkConsistency(bad)).toContainEqual(expect.stringContaining('enum on ghost'));
  });

  it('rejects a property without a type, and a type without a property', () => {
    const bad = structuredClone(base);
    const track = bad.labels.find((l) => l.name === 'Track')!;
    delete track.types.order;
    track.types.ghost = 'string';
    const problems = checkConsistency(bad);
    expect(problems).toContainEqual(expect.stringContaining('Track: no type for order'));
    expect(problems).toContainEqual(expect.stringContaining('Track: type for ghost'));
  });

  it('rejects a per-deal label whose dealProperty is not a property', () => {
    const bad = structuredClone(base);
    const finding = bad.labels.find((l) => l.name === 'Finding')!;
    finding.dealProperty = 'deal';
    expect(checkConsistency(bad)).toContainEqual(expect.stringContaining('Finding: dealProperty deal'));
  });

  it('rejects duplicate labels', () => {
    const bad = structuredClone(base);
    bad.labels.push(structuredClone(bad.labels[0]!));
    expect(checkConsistency(bad)).toContainEqual(expect.stringContaining('duplicate label'));
  });
});

describe('generated DDL', () => {
  it('has 23 key constraints and 13 deal_code indexes, all idempotent', () => {
    const stmts = schemaStatements();
    expect(stmts.filter((s) => s.startsWith('CREATE CONSTRAINT'))).toHaveLength(23);
    expect(stmts.filter((s) => s.startsWith('CREATE INDEX'))).toHaveLength(13);
    expect(stmts.every((s) => s.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('renders composite keys in key order', () => {
    expect(schemaStatements()).toContain(
      'CREATE CONSTRAINT candidate_key IF NOT EXISTS FOR (n:Candidate) REQUIRE (n.deal_code, n.iteration, n.uc, n.pattern) IS UNIQUE',
    );
  });

  it('committed graph/schema.cypher matches the generator (run npm run schema:gen)', () => {
    const path = fileURLToPath(new URL('../../../graph/schema.cypher', import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(renderSchemaCypher());
  });
});
