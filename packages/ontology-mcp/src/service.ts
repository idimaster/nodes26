import neo4j, { type Driver } from 'neo4j-driver';
import type { GateResult, GateStore } from '@planner/gate';
import { ontology } from '@planner/ontology';

/**
 * Ontology server (DESIGN §2, T3.4). get_ontology is the contract the agent plans against: the core
 * ontology plus the active terms of global and the deal. propose_term writes a *proposed*
 * OntologyTerm with MOTIVATED_BY edges and asks the gate; only an approval (in the gate server)
 * activates it, adds its constraint, and makes the guard accept it.
 */

export class OntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyError';
  }
}

export interface Term {
  kind: 'label' | 'relationship';
  name: string;
  scope: string;
  status: string;
  definition: string;
  example: string;
}

export interface ProposeInput {
  deal: string;
  iteration: number;
  kind: 'label' | 'relationship';
  name: string;
  definition: string;
  example: string;
  motivated_by: string[];
}

const LABEL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$/;
const REL_TYPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const CORE = new Set([...ontology.labels.map((l) => l.name), ...ontology.relationships.map((r) => r.type)].map((n) => n.toLowerCase()));

export class OntologyService {
  constructor(
    private readonly driver: Driver,
    private readonly gates: GateStore,
    private readonly opts: { waitSeconds: number },
  ) {}

  async getOntology(deal: string) {
    const { records } = await this.driver.executeQuery(
      `MATCH (t:OntologyTerm)
       WHERE t.status = 'active' AND (t.scope = 'global' OR t.scope = $deal)
       RETURN t {.kind, .name, .scope, .status, .definition, .example} AS term
       ORDER BY t.kind, t.name`,
      { deal },
      { routing: neo4j.routing.READ },
    );
    return {
      core: {
        labels: ontology.labels.map((l) => ({
          name: l.name,
          subgraph: l.subgraph,
          key: l.key,
          required: l.required,
          enums: l.enums,
          per_deal: l.perDeal,
          reserved: l.reserved,
        })),
        relationships: ontology.relationships.map((r) => ({ type: r.type, endpoints: r.endpoints, properties: r.properties })),
      },
      reserved: ontology.labels.filter((l) => l.reserved).map((l) => l.name),
      terms: records.map((r) => r.get('term') as Term),
      guidance:
        'Write only labels and relationship types listed here. If a finding needs a concept that is missing, call propose_term; ' +
        'it becomes usable for this deal only after the architect approves it.',
    };
  }

  async proposeTerm(input: ProposeInput): Promise<GateResult & { term: Term }> {
    const { deal, iteration, kind, name } = input;
    if (kind === 'label' && !LABEL.test(name)) throw new OntologyError(`label ${name} must be UpperCamelCase (e.g. DataResidencyRequirement)`);
    if (kind === 'relationship' && !REL_TYPE.test(name)) throw new OntologyError(`relationship type ${name} must be UPPER_SNAKE (e.g. CONSTRAINED_BY)`);
    if (CORE.has(name.toLowerCase())) throw new OntologyError(`${name} is already in the core ontology; use it instead`);
    if (input.definition.trim() === '' || input.example.trim() === '') throw new OntologyError('a term needs a definition and an example');
    if (input.motivated_by.length === 0) throw new OntologyError('a term needs at least one finding that motivates it');

    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const it = await tx.run('MATCH (i:Iteration {deal_code: $deal, n: $n}) RETURN count(i) AS n', { deal, n: neo4j.int(iteration) });
        if (Number(it.records[0]?.get('n')) === 0) throw new OntologyError(`deal ${deal} has no iteration ${iteration}`);
        const existing = await tx.run(
          'MATCH (t:OntologyTerm) WHERE toLower(t.name) = toLower($name) RETURN t.scope AS scope, t.status AS status LIMIT 1',
          { name },
        );
        const e = existing.records[0];
        if (e) throw new OntologyError(`term ${name} already exists (scope ${String(e.get('scope'))}, ${String(e.get('status'))})`);
        const found = await tx.run('UNWIND $ids AS id MATCH (f:Finding {deal_code: $deal, id: id}) RETURN collect(f.id) AS ids', {
          deal,
          ids: input.motivated_by,
        });
        const ids = found.records[0]?.get('ids') as string[];
        const missing = input.motivated_by.filter((x) => !ids.includes(x));
        if (missing.length > 0) throw new OntologyError(`unknown finding(s) for deal ${deal}: ${missing.join(', ')}`);
        await tx.run(
          `CREATE (t:OntologyTerm {kind: $kind, name: $name, scope: $deal, status: 'proposed',
                                   definition: $definition, example: $example, version: 1})
           WITH t
           UNWIND $ids AS id
           MATCH (f:Finding {deal_code: $deal, id: id})
           CREATE (t)-[:MOTIVATED_BY]->(f)
           RETURN count(*) AS n`,
          { kind, name, deal, definition: input.definition, example: input.example, ids: input.motivated_by },
        );
      });
    } finally {
      await session.close();
    }

    const { gate_id } = await this.gates.requestGate({
      deal,
      iteration,
      gate: 'ontology_term',
      subject_ids: [`OntologyTerm:${kind}/${name}`],
      summary: `New ${kind} ${name} for deal ${deal}: ${input.definition} Example: ${input.example} (motivated by ${input.motivated_by.join(', ')})`,
    });
    const result = await this.gates.waitForDecision(gate_id, this.opts.waitSeconds);
    const term = await this.driver.executeQuery(
      'MATCH (t:OntologyTerm {kind: $kind, name: $name}) RETURN t {.kind, .name, .scope, .status, .definition, .example} AS term',
      { kind, name },
    );
    return { ...result, term: term.records[0]?.get('term') as Term };
  }
}
