import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateStore } from '@planner/gate';
import { ontology } from '@planner/ontology';
import { OntologyService } from '@planner/ontology-mcp';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.4: get_ontology shows core + active terms in scope; propose_term validates, writes, and asks the gate. */

let driver: Driver;
let service: OntologyService;
let gates: GateStore;

const TERM = {
  deal: 'nimbus',
  iteration: 1,
  kind: 'label' as const,
  name: 'DataResidencyRequirement',
  definition: 'A contractual requirement that customer data stays in a region.',
  example: 'EU customer ledgers stay in EU regions.',
  motivated_by: ['f-eu-residency'],
};

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.executeQuery(
    `MATCH (d:Deal {code: 'nimbus'})
     CREATE (i:Iteration {deal_code: 'nimbus', n: 1, started_at: datetime(), status: 'draft'})
     CREATE (d)-[:HAS_ITERATION]->(i)
     CREATE (:OntologyTerm {kind: 'label', name: 'GlobalThing', scope: 'global', status: 'active', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'label', name: 'TidewaterThing', scope: 'tidewater', status: 'active', definition: 'd', example: 'e', version: 1})
     CREATE (:OntologyTerm {kind: 'relationship', name: 'STILL_PROPOSED', scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1})
     RETURN 1`,
  );
  gates = new GateStore(driver);
  service = new OntologyService(driver, gates, { waitSeconds: 2 });
});

afterAll(async () => {
  await driver.executeQuery('DROP CONSTRAINT data_residency_requirement_key IF EXISTS');
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('get_ontology', () => {
  it('returns the core ontology from config/ontology.json', async () => {
    const o = await service.getOntology('nimbus');
    expect(o.core.labels.map((l) => l.name)).toEqual(ontology.labels.map((l) => l.name));
    expect(o.core.relationships.map((r) => r.type)).toEqual(ontology.relationships.map((r) => r.type));
    expect(o.reserved.sort()).toEqual(['Actual', 'Feedback', 'GateDecision', 'OntologyTerm', 'Override']);
    expect(o.core.labels.find((l) => l.name === 'Finding')).toMatchObject({ key: ['deal_code', 'id'], enums: { kind: expect.any(Array) } });
  });

  it("lists only active terms for global and this deal, never another deal's or a proposed one", async () => {
    expect((await service.getOntology('nimbus')).terms.map((t) => t.name)).toEqual(['GlobalThing']);
    expect((await service.getOntology('tidewater')).terms.map((t) => t.name).sort()).toEqual(['GlobalThing', 'TidewaterThing']);
  });
});

describe('propose_term refuses bad proposals and writes nothing', () => {
  const count = async () =>
    Number((await driver.executeQuery("MATCH (t:OntologyTerm {scope: 'nimbus'}) RETURN count(t) AS n")).records[0]?.get('n'));

  it.each([
    ['a label not in UpperCamelCase', { name: 'data_residency' }, /UpperCamelCase/],
    ['a relationship type not in UPPER_SNAKE', { kind: 'relationship' as const, name: 'constrainedBy' }, /UPPER_SNAKE/],
    ['a core label', { name: 'Finding' }, /core ontology/],
    ['a core label in another case', { name: 'FINDING', kind: 'relationship' as const }, /core ontology/],
    ['an existing term', { kind: 'relationship' as const, name: 'STILL_PROPOSED' }, /already exists/],
    ['an unknown finding', { motivated_by: ['f-nope'] }, /f-nope/],
    ['an unknown iteration', { iteration: 9 }, /iteration 9/],
    ['no motivating finding', { motivated_by: [] }, /at least one finding/],
  ])('%s', async (_n, over, message) => {
    const before = await count();
    await expect(service.proposeTerm({ ...TERM, ...over })).rejects.toThrow(message);
    expect(await count()).toBe(before);
  });
});

describe('propose_term asks the gate', () => {
  it('writes the proposed term with MOTIVATED_BY, opens an ontology_term gate, and returns pending', async () => {
    const r = await service.proposeTerm(TERM);
    expect(r).toMatchObject({ status: 'pending', gate_id: 'gd-nimbus-1-ontology_term-1', term: { kind: 'label', name: TERM.name, status: 'proposed' } });
    const { records } = await driver.executeQuery(
      `MATCH (t:OntologyTerm {kind: 'label', name: $name})-[:MOTIVATED_BY]->(f:Finding)
       MATCH (g:GateDecision {id: $gate})-[:DECIDED_ON]->(t)
       RETURN t.scope AS scope, t.status AS status, f.id AS finding, g.gate AS gate, g.status AS gate_status`,
      { name: TERM.name, gate: r.gate_id },
    );
    expect(records[0]?.toObject()).toEqual({ scope: 'nimbus', status: 'proposed', finding: 'f-eu-residency', gate: 'ontology_term', gate_status: 'pending' });
  });

  it('returns the decision when the architect decides while it waits', async () => {
    const pending = service.proposeTerm({ ...TERM, name: 'RegionPinning' });
    await new Promise((r) => setTimeout(r, 300));
    await gates.decide('gd-nimbus-1-ontology_term-2', { action: 'approve', comment: '', by: 'architect' });
    expect(await pending).toMatchObject({ status: 'approved', term: { name: 'RegionPinning', status: 'active' } });
    expect((await service.getOntology('nimbus')).terms.map((t) => t.name)).toContain('RegionPinning');
    expect((await service.getOntology('tidewater')).terms.map((t) => t.name)).not.toContain('RegionPinning');
    await driver.executeQuery('DROP CONSTRAINT region_pinning_key IF EXISTS');
  });
});
