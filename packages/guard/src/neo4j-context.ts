import neo4j, { type Driver } from 'neo4j-driver';
import type { GateRecord, GuardContext, Term } from './validate.js';

const toNumber = (v: unknown): number => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));

/**
 * Builds the guard context from the graph with read-only queries: one for active ontology
 * terms (global and this deal), and one gate lookup when G8 asks for it.
 */
export async function loadContext(driver: Driver, deal: string | undefined): Promise<GuardContext> {
  const { records } = await driver.executeQuery(
    `MATCH (t:OntologyTerm)
     WHERE t.status = 'active' AND (t.scope = 'global' OR t.scope = $deal)
     RETURN t.kind AS kind, t.name AS name, t.scope AS scope`,
    { deal: deal ?? null },
    { routing: neo4j.routing.READ },
  );
  const activeTerms: Term[] = records.map((r) => ({
    kind: r.get('kind') as Term['kind'],
    name: r.get('name') as string,
    scope: r.get('scope') as string,
  }));
  return {
    activeTerms,
    lookupGate: async (id: string): Promise<GateRecord | null> => {
      const { records: gates } = await driver.executeQuery(
        `MATCH (g:GateDecision {id: $id})
         RETURN g.deal_code AS deal_code, g.iteration AS iteration, g.gate AS gate, g.status AS status`,
        { id },
        { routing: neo4j.routing.READ },
      );
      const g = gates[0];
      return g
        ? {
            deal_code: g.get('deal_code') as string,
            iteration: toNumber(g.get('iteration')),
            gate: g.get('gate') as string,
            status: g.get('status') as string,
          }
        : null;
    },
  };
}
