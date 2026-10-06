import { z } from 'zod';

/**
 * Standard writes for the agent workflow (DESIGN §6). Every template follows the CLAUDE.md
 * Cypher style: parameters only, `$deal` on every per-deal match, MERGE on keys with nodes
 * before relationships, no reserved labels, and a final RETURN. `uc` is always a UseCase id,
 * and a FramedUseCase's id equals its use_case_id (DESIGN §1.3). Integer parameters are wrapped in
 * toInteger(): MCP hosts pass JSON numbers, which would otherwise be stored as floats.
 *
 * Safety contract (DESIGN §2.5): plan writes only touch a *draft* iteration; status is set to
 * 'draft' only on create; no template re-points an existing Selection except replace_selection.
 * Templates never throw on refused rows: they return counts (or no rows), and the caller compares
 * them with its input.
 */

const deal = z.string().min(1);
const iteration = z.number().int().positive();
const id = z.string().min(1);

interface Template {
  description: string;
  query: string;
  params: z.ZodObject;
  /** Contains DELETE. The guard admits it only as this exact text (DESIGN §3, G2). */
  destructive?: boolean;
}

const TEMPLATES = {
  set_deal_strategy: {
    description: 'Record the strategy approved at the frame gate.',
    params: z.object({ deal, strategy: z.enum(['bridge', 'transform']) }).strict(),
    query: `MATCH (d:Deal {code: $deal})
SET d.strategy = $strategy
RETURN d.code AS deal, d.strategy AS strategy`,
  },

  create_iteration: {
    description: 'Start iteration n of a deal as a draft.',
    params: z.object({ deal, n: iteration, started_at: z.iso.datetime() }).strict(),
    query: `MATCH (d:Deal {code: $deal})
MERGE (i:Iteration {deal_code: $deal, n: toInteger($n)})
ON CREATE SET i.started_at = datetime($started_at), i.status = 'draft'
MERGE (d)-[:HAS_ITERATION]->(i)
RETURN i.n AS iteration, i.status AS status`,
  },

  classify_findings: {
    description: 'Store the classify_finding result on each finding (the original kind is kept).',
    params: z
      .object({
        deal,
        rows: z.array(z.object({ id, classified_as: z.enum(['capability', 'gap', 'risk', 'assumption', 'service']) }).strict()),
      })
      .strict(),
    query: `UNWIND $rows AS row
MATCH (f:Finding {deal_code: $deal, id: row.id})
SET f.classified_as = row.classified_as
RETURN count(f) AS classified`,
  },

  write_framed_use_cases: {
    description:
      'Write draft framings: one FramedUseCase per use case, framed from one or more findings. ' +
      'A row with an unknown use case or finding id is not written (framed < rows)',
    params: z
      .object({
        deal,
        iteration,
        rows: z.array(
          z.object({ use_case_id: id, framing_rationale: z.string().min(1), finding_ids: z.array(id).min(1) }).strict(),
        ),
      })
      .strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
WHERE i.status = 'draft'
UNWIND $rows AS row
MATCH (u:UseCase {id: row.use_case_id})
CALL (row) {
  OPTIONAL MATCH (f:Finding {deal_code: $deal})
  WHERE f.id IN row.finding_ids
  RETURN count(DISTINCT f) AS found
}
WITH i, row, u, found
WHERE found = size(row.finding_ids)
MERGE (fu:FramedUseCase {deal_code: $deal, iteration: toInteger($iteration), id: row.use_case_id})
ON CREATE SET fu.status = 'draft'
SET fu.use_case_id = row.use_case_id, fu.framing_rationale = row.framing_rationale
MERGE (fu)-[:IN_ITERATION]->(i)
MERGE (fu)-[:INSTANCE_OF]->(u)
WITH fu, row
MATCH (f:Finding {deal_code: $deal})
WHERE f.id IN row.finding_ids
MERGE (fu)-[:FRAMED_FROM]->(f)
RETURN count(DISTINCT fu) AS framed, count(f) AS framed_from`,
  },

  write_candidates: {
    description: 'Write the scored candidates (top 3 per use case) from analyze_pattern_fit.',
    params: z
      .object({
        deal,
        iteration,
        rows: z.array(
          z
            .object({
              uc: id,
              pattern: id,
              fit_score: z.number().min(0).max(100),
              band: z.enum(['recommend', 'surface', 'review', 'hidden']),
              signal_snapshot: z.string().min(2),
            })
            .strict(),
        ),
      })
      .strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
WHERE i.status = 'draft'
UNWIND $rows AS row
MATCH (fu:FramedUseCase {deal_code: $deal, iteration: toInteger($iteration), id: row.uc})
MATCH (p:Pattern {id: row.pattern})
MERGE (c:Candidate {deal_code: $deal, iteration: toInteger($iteration), uc: row.uc, pattern: row.pattern})
SET c.fit_score = row.fit_score, c.band = row.band, c.signal_snapshot = row.signal_snapshot
MERGE (c)-[:IN_ITERATION]->(i)
MERGE (c)-[:FOR]->(fu)
MERGE (c)-[:OF]->(p)
RETURN count(c) AS candidates`,
  },

  write_selections: {
    description:
      'Write draft selections; every other candidate of the use case becomes ALTERNATIVE_TO it. ' +
      'Never re-points an existing selection: a different pattern is listed in `rejected` (use replace_selection)',
    params: z
      .object({
        deal,
        iteration,
        rows: z.array(
          z.object({ uc: id, pattern: id, fit_score: z.number().min(0).max(100), rationale: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
WHERE i.status = 'draft'
UNWIND $rows AS row
MATCH (fu:FramedUseCase {deal_code: $deal, iteration: toInteger($iteration), id: row.uc})
MATCH (p:Pattern {id: row.pattern})
OPTIONAL MATCH (prev:Selection {deal_code: $deal, iteration: toInteger($iteration), uc: row.uc})
WITH i, row, fu, p, prev IS NULL OR (prev.status = 'draft' AND prev.pattern = row.pattern) AS writable
CALL (i, row, fu, p, writable) {
  WITH * WHERE writable
  MERGE (s:Selection {deal_code: $deal, iteration: toInteger($iteration), uc: row.uc})
  ON CREATE SET s.status = 'draft', s.pattern = row.pattern
  SET s.fit_score = row.fit_score, s.rationale = row.rationale
  MERGE (s)-[:IN_ITERATION]->(i)
  MERGE (s)-[:FOR]->(fu)
  MERGE (s)-[:SELECTS]->(p)
  WITH s, row
  CALL (s, row) {
    MATCH (c:Candidate {deal_code: $deal, iteration: toInteger($iteration), uc: row.uc})
    WHERE c.pattern <> row.pattern
    MERGE (c)-[:ALTERNATIVE_TO]->(s)
    RETURN count(c) AS alternatives
  }
  RETURN count(s) AS written, sum(alternatives) AS alternatives
}
RETURN sum(written) AS selections, sum(alternatives) AS alternatives,
       collect(CASE WHEN writable THEN null ELSE row.uc END) AS rejected`,
  },

  replace_selection: {
    description:
      'Repair: switch a draft selection in a draft iteration to another pattern. Removes its old SELECTS ' +
      'edge, PlanTasks, and ALTERNATIVE_TO edges, then re-links alternatives. Refuses (no rows) when any of ' +
      'its PlanTasks carries a gate, feedback, or actual edge. Afterwards re-run write_plan_tasks',
    destructive: true,
    params: z
      .object({ deal, iteration, uc: id, pattern: id, fit_score: z.number().min(0).max(100), rationale: z.string().min(1) })
      .strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
WHERE i.status = 'draft'
MATCH (s:Selection {deal_code: $deal, iteration: toInteger($iteration), uc: $uc})-[:IN_ITERATION]->(i)
WHERE s.status = 'draft'
  AND NOT EXISTS { (s)-[:HAS_TASK]->(:PlanTask)<-[:ON|RESOLVED_BY|DECIDED_ON|OBSERVED_FOR]-() }
MATCH (p:Pattern {id: $pattern})
CALL (s) {
  OPTIONAL MATCH (s)-[old:SELECTS]->(:Pattern)
  DELETE old
}
CALL (s) {
  OPTIONAL MATCH (s)-[:HAS_TASK]->(t:PlanTask {deal_code: $deal, iteration: toInteger($iteration)})
  DETACH DELETE t
}
CALL (s) {
  OPTIONAL MATCH (:Candidate)-[alt:ALTERNATIVE_TO]->(s)
  DELETE alt
}
SET s.pattern = $pattern, s.fit_score = $fit_score, s.rationale = $rationale
MERGE (s)-[:SELECTS]->(p)
WITH s
CALL (s) {
  MATCH (c:Candidate {deal_code: $deal, iteration: toInteger($iteration), uc: $uc})
  WHERE c.pattern <> $pattern
  MERGE (c)-[:ALTERNATIVE_TO]->(s)
  RETURN count(c) AS alternatives
}
RETURN s.uc AS uc, s.pattern AS pattern, alternatives`,
  },

  write_plan_tasks: {
    description:
      "Instantiate the plan in the graph: one PlanTask per catalog Task of each draft Selection's pattern " +
      '(weeks and skill copied from the catalog), DEPENDS_ON from the catalog within a selection, and from ' +
      'each root task to the final tasks of every selection whose pattern it REQUIRES. Takes no tasks or ' +
      'edges from the caller. Then schedule with planner-graph schedule_plan',
    params: z.object({ deal, iteration }).strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
WHERE i.status = 'draft'
CALL (i) {
  MATCH (s:Selection {deal_code: $deal, iteration: toInteger($iteration)})-[:SELECTS]->(p:Pattern)-[:HAS_TASK]->(t:Task)
  MERGE (pt:PlanTask {deal_code: $deal, iteration: toInteger($iteration), id: s.uc + ':' + t.id})
  ON CREATE SET pt.status = 'draft'
  SET pt.task_id = t.id, pt.weeks_o = t.weeks_o, pt.weeks_e = t.weeks_e, pt.weeks_p = t.weeks_p, pt.skill = t.skill,
      pt.earliest_start = null, pt.wave = null, pt.on_critical_path = null
  MERGE (pt)-[:IN_ITERATION]->(i)
  MERGE (s)-[:HAS_TASK]->(pt)
  MERGE (pt)-[:INSTANTIATES]->(t)
  RETURN count(pt) AS tasks
}
CALL () {
  MATCH (s:Selection {deal_code: $deal, iteration: toInteger($iteration)})-[:HAS_TASK]->(a:PlanTask)-[:INSTANTIATES]->(ta:Task)
  MATCH (ta)-[:DEPENDS_ON]->(tb:Task)<-[:INSTANTIATES]-(b:PlanTask)<-[:HAS_TASK]-(s)
  MERGE (a)-[:DEPENDS_ON]->(b)
  RETURN count(*) AS within
}
CALL () {
  MATCH (s:Selection {deal_code: $deal, iteration: toInteger($iteration)})-[:SELECTS]->(:Pattern)-[:REQUIRES]->(q:Pattern)
  MATCH (q)<-[:SELECTS]-(s2:Selection {deal_code: $deal, iteration: toInteger($iteration)})
  WHERE s2.uc <> s.uc
  MATCH (s)-[:HAS_TASK]->(a:PlanTask)-[:INSTANTIATES]->(ta:Task)
  WHERE NOT EXISTS { (ta)-[:DEPENDS_ON]->(:Task) }
  MATCH (s2)-[:HAS_TASK]->(b:PlanTask)-[:INSTANTIATES]->(tb:Task)
  WHERE NOT EXISTS { (tb)<-[:DEPENDS_ON]-(:Task) }
  MERGE (a)-[:DEPENDS_ON]->(b)
  RETURN count(*) AS across
}
RETURN tasks, within + across AS edges`,
  },

  commit_roadmap: {
    description:
      'Promote the iteration to committed. Needs $gate_id of an approved commit gate (guard G8). ' +
      'Refuses (no rows) if this roadmap version already belongs to another iteration',
    params: z.object({ deal, iteration, version: z.number().int().positive(), gate_id: id }).strict(),
    query: `MATCH (i:Iteration {deal_code: $deal, n: toInteger($iteration)})
OPTIONAL MATCH (prev:Roadmap {deal_code: $deal, version: toInteger($version)})
WITH i, prev
WHERE prev IS NULL OR prev.iteration = toInteger($iteration)
MERGE (r:Roadmap {deal_code: $deal, version: toInteger($version)})
SET r.iteration = toInteger($iteration), r.gate_id = $gate_id, r.status = 'committed', i.status = 'committed'
WITH r
CALL (r) {
  MATCH (s:Selection {deal_code: $deal, iteration: toInteger($iteration)})
  SET s.status = 'committed'
  MERGE (r)-[:INCLUDES]->(s)
  RETURN count(s) AS included
}
CALL () {
  MATCH (fu:FramedUseCase {deal_code: $deal, iteration: toInteger($iteration)})
  WHERE fu.status = 'draft'
  SET fu.status = 'committed'
  RETURN count(fu) AS framings
}
CALL () {
  MATCH (pt:PlanTask {deal_code: $deal, iteration: toInteger($iteration)})
  WHERE pt.status = 'draft'
  SET pt.status = 'committed'
  RETURN count(pt) AS tasks
}
RETURN r.version AS version, included, framings + tasks AS promoted`,
  },

  write_capability_decisions: {
    description: 'Write buy-vs-build outcomes from classify_buy_build.',
    params: z
      .object({
        deal,
        iteration,
        rows: z.array(
          z
            .object({
              capability_id: id,
              outcome: z.enum(['integrate', 'build', 'retire', 'review']),
              integrate_effort: z.number().min(0),
              build_effort: z.number().min(0),
              coverage: z.number().min(0).max(1),
              rule_version: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    query: `MATCH (d:Deal {code: $deal})-[:HAS_ITERATION]->(:Iteration {deal_code: $deal, n: toInteger($iteration)})
UNWIND $rows AS row
MERGE (c:CapabilityDecision {deal_code: $deal, iteration: toInteger($iteration), capability_id: row.capability_id})
SET c.outcome = row.outcome, c.integrate_effort = row.integrate_effort, c.build_effort = row.build_effort,
    c.coverage = row.coverage, c.rule_version = row.rule_version
MERGE (d)-[:HAS_DECISION]->(c)
RETURN count(c) AS decisions`,
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;

export const templateNames = (): TemplateName[] => Object.keys(TEMPLATES) as TemplateName[];

export function cypherTemplate(name: string): {
  name: TemplateName;
  description: string;
  query: string;
  params_schema: Record<string, unknown>;
  destructive: boolean;
} {
  if (!(name in TEMPLATES)) {
    throw new Error(`unknown template ${JSON.stringify(name)}; known: ${templateNames().join(', ')}`);
  }
  const t: Template = TEMPLATES[name as TemplateName];
  return {
    name: name as TemplateName,
    description: t.description,
    query: t.query,
    params_schema: z.toJSONSchema(t.params) as Record<string, unknown>,
    destructive: t.destructive ?? false,
  };
}

/** Validates params for a template; throws with the zod message. */
export function templateParams(name: TemplateName, params: unknown): Record<string, unknown> {
  return (TEMPLATES[name] as Template).params.parse(params) as Record<string, unknown>;
}
