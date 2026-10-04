import { EventEmitter } from 'node:events';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import { snake } from '@planner/ontology';
import { parseOverrides, type ParsedOverride } from './grammar.js';
import { parseSubject, type SubjectRef } from './subjects.js';

/**
 * The gate server's own access to the graph (DESIGN §4). It is the only writer of GateDecision,
 * Feedback, and Override, and the only path by which an OntologyTerm becomes active.
 * Labels in these queries are fixed strings; the only spliced name is an approved term's label,
 * validated before it reaches DDL.
 */

export type GateKind = 'frame' | 'select' | 'commit' | 'ontology_term' | 'ontology_promote';
export type Action = 'approve' | 'approve_except' | 'reject';

export class GateError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}

export interface OverrideView {
  id: string;
  kind: ParsedOverride['kind'];
  subject: string;
  value: string;
}

export interface GateResult {
  status: 'pending' | 'approved' | 'rejected';
  gate_id: string;
  feedback_ids: string[];
  overrides: OverrideView[];
}

export interface SubjectView {
  ref: string;
  label: string;
  title: string;
  fit_score?: number;
  alternatives?: { pattern: string; fit_score: number }[];
}

export interface GateView {
  id: string;
  deal_code: string;
  iteration: number;
  gate: GateKind;
  status: GateResult['status'];
  summary: string;
  comment: string;
  at: string;
  subjects: SubjectView[];
}

const PLAN_LABELS = ['Iteration', 'FramedUseCase', 'Candidate', 'Selection', 'PlanTask', 'Roadmap', 'CapabilityDecision'];
const INTEGER_KEYS = new Set(['iteration', 'n', 'version']);
const LABEL_NAME = /^[A-Z][A-Za-z0-9]*$/;
const EXCLUSIONS = new Set(['exclude_pattern', 'exclude_use_case']);

/** Takes the write lock on one node for the rest of the transaction, so a re-read sees the latest state. */
async function lock(tx: ManagedTransaction, match: string, params: Record<string, unknown>): Promise<boolean> {
  const r = await tx.run(`${match} SET n._lock = true REMOVE n._lock RETURN count(n) AS n`, params);
  return Number(r.records[0]?.get('n')) > 0;
}

const toNum = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));

function keyParams(ref: SubjectRef): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ref.key).map(([k, v]) => [k, INTEGER_KEYS.has(k) ? neo4j.int(v as number) : v]));
}

/** Renders a node back into its subject reference. */
const REF_OF = `CASE labels(s)[0]
  WHEN 'Selection' THEN 'Selection:' + s.uc
  WHEN 'Candidate' THEN 'Candidate:' + s.uc + '/' + s.pattern
  WHEN 'Iteration' THEN 'Iteration:' + toString(s.n)
  WHEN 'Roadmap' THEN 'Roadmap:' + toString(s.version)
  WHEN 'CapabilityDecision' THEN 'CapabilityDecision:' + s.capability_id
  WHEN 'OntologyTerm' THEN 'OntologyTerm:' + s.kind + '/' + s.name
  ELSE labels(s)[0] + ':' + s.id END`;

export class GateStore {
  private readonly events = new EventEmitter();

  constructor(private readonly driver: Driver) {
    this.events.setMaxListeners(0);
  }

  /** Resolves subject references to element ids; throws listing every subject that does not exist. */
  private async resolve(refs: string[], deal: string, iteration: number, tx?: ManagedTransaction): Promise<string[]> {
    const ids: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      let parsed: SubjectRef;
      try {
        parsed = parseSubject(ref, deal, iteration);
      } catch (e) {
        throw new GateError('invalid', e instanceof Error ? e.message : String(e));
      }
      const where = Object.keys(parsed.key).map((k) => `${k}: $${k}`).join(', ');
      const query = `MATCH (n:${parsed.label} {${where}}) RETURN elementId(n) AS id`;
      const records = tx
        ? (await tx.run(query, keyParams(parsed))).records
        : (await this.driver.executeQuery(query, keyParams(parsed))).records;
      const id = records[0]?.get('id') as string | undefined;
      if (id) ids.push(id);
      else missing.push(ref);
    }
    if (missing.length > 0) throw new GateError('invalid', `unknown subject(s) for deal ${deal}, iteration ${iteration}: ${missing.join(', ')}`);
    return ids;
  }

  async requestGate(input: { deal: string; iteration: number; gate: GateKind; subject_ids: string[]; summary: string }): Promise<{ gate_id: string }> {
    if (input.subject_ids.length === 0) throw new GateError('invalid', 'a gate needs at least one subject');
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        // Serializes gate requests per deal, so concurrent requests get distinct ids.
        if (!(await lock(tx, 'MATCH (n:Deal {code: $deal})', { deal: input.deal }))) {
          throw new GateError('invalid', `deal ${input.deal} does not exist`);
        }
        const subjects = await this.resolve(input.subject_ids, input.deal, input.iteration, tx);
        const count = await tx.run(
          'MATCH (g:GateDecision {deal_code: $deal, iteration: $iteration, gate: $gate}) RETURN count(g) AS n',
          { deal: input.deal, iteration: neo4j.int(input.iteration), gate: input.gate },
        );
        const gateId = `gd-${input.deal}-${input.iteration}-${input.gate}-${toNum(count.records[0]?.get('n')) + 1}`;
        await tx.run(
          `CREATE (g:GateDecision {id: $id, deal_code: $deal, iteration: $iteration, gate: $gate, status: 'pending',
                                   comment: '', by: '', at: datetime(), summary: $summary})
           WITH g
           UNWIND $subjects AS sid
           MATCH (s) WHERE elementId(s) = sid
           CREATE (g)-[:DECIDED_ON]->(s)
           RETURN count(*) AS n`,
          { id: gateId, deal: input.deal, iteration: neo4j.int(input.iteration), gate: input.gate, summary: input.summary, subjects },
        );
        return { gate_id: gateId };
      });
    } finally {
      await session.close();
    }
  }

  async getResult(gateId: string): Promise<GateResult | null> {
    const { records } = await this.driver.executeQuery(
      `MATCH (g:GateDecision {id: $id})
       RETURN g.status AS status,
              COLLECT { MATCH (f:Feedback)-[:FROM]->(g) RETURN f.id ORDER BY f.id } AS feedback_ids,
              COLLECT { MATCH (g)-[:CREATED]->(o:Override)
                        RETURN {id: o.id, kind: o.kind, subject: o.subject, value: o.value} AS o ORDER BY size(o.id), o.id } AS overrides`,
      { id: gateId },
    );
    const r = records[0];
    if (!r) return null;
    return {
      status: r.get('status') as GateResult['status'],
      gate_id: gateId,
      feedback_ids: r.get('feedback_ids') as string[],
      overrides: r.get('overrides') as OverrideView[],
    };
  }

  async decide(gateId: string, input: { action: Action; comment: string; by: string }): Promise<GateResult> {
    // Checks in the order a caller can act on: the gate exists (404), is still pending (409), then the input (400).
    const pre = await this.driver.executeQuery(
      `MATCH (g:GateDecision {id: $id})
       RETURN g.status AS status, g.gate AS gate,
              COLLECT { MATCH (g)-[:DECIDED_ON]->(t:OntologyTerm) RETURN t {.kind, .name, .status} } AS terms`,
      { id: gateId },
    );
    const head = pre.records[0];
    if (!head) throw new GateError('not_found', `gate ${gateId} does not exist`);
    if (head.get('status') !== 'pending') throw new GateError('conflict', `gate ${gateId} is already ${String(head.get('status'))}`);
    const terms = head.get('terms') as { kind: string; name: string; status: string }[];
    const approving = input.action !== 'reject';

    const catalog = await this.driver.executeQuery(
      'MATCH (p:Pattern) WITH collect(p.id) AS patterns MATCH (u:UseCase) RETURN patterns, collect(u.id) AS useCases',
    );
    const overrides = parseOverrides(input.comment, {
      patterns: new Set(catalog.records[0]?.get('patterns') as string[]),
      useCases: new Set(catalog.records[0]?.get('useCases') as string[]),
    });
    if (input.action === 'approve_except' && !overrides.some((o) => EXCLUSIONS.has(o.kind))) {
      throw new GateError('invalid', "approve except needs at least one exclusion, e.g. 'except cdc-replication'");
    }
    const status = input.action === 'reject' ? 'rejected' : 'approved';
    const comment = input.comment.trim();

    // Ontology gates: validate before anything is written, and create the constraint first (idempotent DDL),
    // so a decision is never committed without its constraint.
    if (head.get('gate') === 'ontology_term' && approving) {
      for (const t of terms) {
        if (t.status !== 'proposed') throw new GateError('invalid', `term ${t.name} is ${t.status}, not proposed`);
        if (t.kind === 'label' && !LABEL_NAME.test(t.name)) {
          throw new GateError('invalid', `term name ${t.name} is not a valid label (expected UpperCamelCase)`);
        }
      }
      for (const t of terms.filter((x) => x.kind === 'label')) {
        await this.driver.executeQuery(
          `CREATE CONSTRAINT ${snake(t.name)}_key IF NOT EXISTS FOR (n:${t.name}) REQUIRE (n.deal_code, n.id) IS UNIQUE`,
        );
      }
    }
    if (head.get('gate') === 'ontology_promote' && approving) {
      for (const t of terms) if (t.status !== 'active') throw new GateError('invalid', `term ${t.name} is ${t.status}; only an active term can be promoted`);
    }

    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        await lock(tx, 'MATCH (n:GateDecision {id: $id})', { id: gateId });
        const g = await tx.run('MATCH (g:GateDecision {id: $id}) RETURN g.status AS status, g.deal_code AS deal, g.gate AS gate', { id: gateId });
        const row = g.records[0];
        if (!row) throw new GateError('not_found', `gate ${gateId} does not exist`);
        if (row.get('status') !== 'pending') throw new GateError('conflict', `gate ${gateId} is already ${String(row.get('status'))}`);
        const deal = row.get('deal') as string;
        const gate = row.get('gate') as GateKind;

        await tx.run('MATCH (g:GateDecision {id: $id}) SET g.status = $status, g.by = $by, g.at = datetime(), g.comment = $comment RETURN g', {
          id: gateId,
          status,
          by: input.by,
          comment,
        });

        if (comment !== '') {
          await tx.run(
            `MATCH (g:GateDecision {id: $id})
             CREATE (f:Feedback {id: $fid, deal_code: $deal, text: $text, status: 'open'})
             CREATE (f)-[:FROM]->(g)
             WITH f, g
             MATCH (g)-[:DECIDED_ON]->(s)
             WHERE any(l IN labels(s) WHERE l IN $planLabels)
             CREATE (f)-[:ON]->(s)
             RETURN count(*) AS n`,
            { id: gateId, fid: `fb-${gateId}`, deal, text: comment, planLabels: PLAN_LABELS },
          );
        }

        for (const [n, o] of overrides.entries()) {
          await tx.run(
            `MATCH (g:GateDecision {id: $gid})
             CREATE (o:Override {id: $id, deal_code: $deal, kind: $kind, subject: $subject, value: $value, active: true})
             CREATE (g)-[:CREATED]->(o)
             WITH o
             OPTIONAL MATCH (t) WHERE (t:Pattern OR t:UseCase) AND t.id = $subject AND $subject <> ''
             FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | CREATE (o)-[:CONSTRAINS]->(t))
             RETURN o.id AS id`,
            { gid: gateId, id: `ov-${gateId}-${n + 1}`, deal, kind: o.kind, subject: o.subject, value: o.value },
          );
        }

        if (gate === 'ontology_term' || gate === 'ontology_promote') {
          await tx.run(
            `MATCH (g:GateDecision {id: $id})-[:DECIDED_ON]->(t:OntologyTerm)
             SET t.status = CASE
                   WHEN $gate = 'ontology_term' AND $status = 'approved' THEN 'active'
                   WHEN $gate = 'ontology_term' THEN 'rejected'
                   ELSE t.status END,
                 t.scope = CASE WHEN $gate = 'ontology_promote' AND $status = 'approved' THEN 'global' ELSE t.scope END
             FOREACH (_ IN CASE WHEN $status = 'approved' THEN [1] ELSE [] END | MERGE (t)-[:APPROVED_BY]->(g))
             RETURN count(t) AS n`,
            { id: gateId, gate, status },
          );
        }
      });
    } finally {
      await session.close();
    }

    this.events.emit(gateId);
    return (await this.getResult(gateId)) as GateResult;
  }

  /** Long-poll: resolves on a decision in this process at once, and checks the graph every second for others. */
  async waitForDecision(gateId: string, seconds: number): Promise<GateResult> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const result = await this.getResult(gateId);
      if (!result) throw new GateError('not_found', `gate ${gateId} does not exist`);
      const remaining = deadline - Date.now();
      if (result.status !== 'pending' || remaining <= 0) return result;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.events.off(gateId, done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(1000, remaining));
        this.events.on(gateId, done);
      });
    }
  }

  async resolveFeedback(input: { deal: string; iteration: number; feedback_id: string; resolved_by_ids: string[] }) {
    if (input.resolved_by_ids.length === 0) throw new GateError('invalid', 'resolved_by_ids needs at least one subject');
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        await lock(tx, 'MATCH (n:Feedback {id: $id, deal_code: $deal})', { id: input.feedback_id, deal: input.deal });
        const f = await tx.run('MATCH (f:Feedback {id: $id, deal_code: $deal}) RETURN f.status AS status', {
          id: input.feedback_id,
          deal: input.deal,
        });
        const row = f.records[0];
        if (!row) throw new GateError('not_found', `feedback ${input.feedback_id} does not exist for deal ${input.deal}`);
        if (row.get('status') !== 'open') throw new GateError('conflict', `feedback ${input.feedback_id} is already ${String(row.get('status'))}`);
        const ids = await this.resolve(input.resolved_by_ids, input.deal, input.iteration, tx);
        const linked = await tx.run(
          `MATCH (f:Feedback {id: $id})
           UNWIND $ids AS sid
           MATCH (s) WHERE elementId(s) = sid AND any(l IN labels(s) WHERE l IN $planLabels)
           MERGE (f)-[:RESOLVED_BY]->(s)
           SET f.status = 'resolved'
           RETURN count(s) AS n`,
          { id: input.feedback_id, ids, planLabels: PLAN_LABELS },
        );
        if (toNum(linked.records[0]?.get('n')) !== ids.length) {
          throw new GateError('invalid', 'feedback can only be resolved by plan nodes');
        }
        return { feedback_id: input.feedback_id, status: 'resolved' as const, resolved_by: input.resolved_by_ids };
      });
    } finally {
      await session.close();
    }
  }

  async listGates(status?: GateResult['status']): Promise<GateView[]> {
    const { records } = await this.driver.executeQuery(
      `MATCH (g:GateDecision)
       WHERE $status IS NULL OR g.status = $status
       RETURN g {.id, .deal_code, .iteration, .gate, .status, .summary, .comment, at: toString(g.at)} AS gate,
              COLLECT {
                MATCH (g)-[:DECIDED_ON]->(s)
                RETURN {
                  ref: ${REF_OF},
                  label: labels(s)[0],
                  title: CASE WHEN s:Selection THEN s.uc + ' → ' + s.pattern ELSE substring(${REF_OF}, size(labels(s)[0]) + 1) END,
                  fit_score: s.fit_score,
                  alternatives: CASE WHEN s:Selection THEN COLLECT {
                    MATCH (c:Candidate)-[:ALTERNATIVE_TO]->(s) WHERE c.fit_score >= s.fit_score - 20
                    RETURN {pattern: c.pattern, fit_score: c.fit_score} ORDER BY c.fit_score DESC } END
                } AS subject ORDER BY subject.ref
              } AS subjects
       ORDER BY g.at, g.id`,
      { status: status ?? null },
    );
    return records.map((r) => {
      const g = r.get('gate') as Record<string, unknown>;
      return {
        id: g.id as string,
        deal_code: g.deal_code as string,
        iteration: toNum(g.iteration),
        gate: g.gate as GateKind,
        status: g.status as GateResult['status'],
        summary: (g.summary as string | null) ?? '',
        comment: (g.comment as string | null) ?? '',
        at: g.at as string,
        subjects: (r.get('subjects') as Record<string, unknown>[]).map((s) => {
          const view: SubjectView = { ref: s.ref as string, label: s.label as string, title: s.title as string };
          if (s.fit_score !== null && s.fit_score !== undefined) view.fit_score = toNum(s.fit_score);
          if (Array.isArray(s.alternatives)) {
            view.alternatives = (s.alternatives as { pattern: string; fit_score: unknown }[]).map((a) => ({
              pattern: a.pattern,
              fit_score: toNum(a.fit_score),
            }));
          }
          return view;
        }),
      };
    });
  }
}
