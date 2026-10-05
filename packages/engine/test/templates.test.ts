import { describe, expect, it } from 'vitest';
import { cypherTemplate, templateNames, templateParams } from '../src/index.js';

const RESERVED = ['GateDecision', 'Feedback', 'Override', 'Actual', 'OntologyTerm'];
const lastClause = (q: string) => q.trim().split('\n').filter((l) => !l.startsWith(' ')).at(-1) ?? '';

describe('cypherTemplate', () => {
  it.each(templateNames())('%s follows the CLAUDE.md Cypher style and guard rules', (name) => {
    const { query, params_schema, destructive } = cypherTemplate(name);
    expect(query).toMatch(/\$deal\b/);
    expect(lastClause(query)).toMatch(/^RETURN\b/); // G9: the statement itself ends with RETURN
    expect(query).not.toMatch(/\*\s*\d*\s*(\.\.\s*\d*\s*)?\]/); // G4: no variable-length patterns at all
    expect(query).not.toContain(';'); // G1
    for (const label of RESERVED) expect(query).not.toMatch(new RegExp(`:${label}\\b`)); // G7
    expect(query).not.toMatch(/apoc\.|dbms\.|LOAD CSV|FOREACH|IN TRANSACTIONS|\bREMOVE\b|\bDROP\b/i); // G2, G3
    if (!destructive) expect(query).not.toMatch(/\bDELETE\b|\bDETACH\b/i); // G2 without the exception
    if (name !== 'commit_roadmap') expect(query).not.toMatch(/committed/); // G8 is reserved for the commit
    expect(params_schema).toMatchObject({ type: 'object', required: expect.arrayContaining(['deal']) });
  });

  it('marks only replace_selection as destructive', () => {
    expect(templateNames().filter((n) => cypherTemplate(n).destructive)).toEqual(['replace_selection']);
  });

  it('sets draft status only on create, so a re-run never demotes a committed node', () => {
    for (const name of templateNames()) {
      const { query } = cypherTemplate(name);
      for (const line of query.split('\n').filter((l) => /status = 'draft'/.test(l) && /\bSET\b/.test(l))) {
        expect(line, `${name}: ${line}`).toMatch(/ON CREATE SET/);
      }
    }
  });

  it('names the known templates when asked for an unknown one', () => {
    expect(() => cypherTemplate('nope')).toThrow(/write_selections/);
  });
});

describe('templateParams', () => {
  it('validates params against the template schema', () => {
    expect(templateParams('set_deal_strategy', { deal: 'nimbus', strategy: 'bridge' })).toEqual({
      deal: 'nimbus',
      strategy: 'bridge',
    });
    expect(() => templateParams('set_deal_strategy', { deal: 'nimbus', strategy: 'absorb' })).toThrow();
    expect(() => templateParams('write_plan_tasks', { deal: 'nimbus', iteration: 1, extra: 1 })).toThrow();
  });
});
