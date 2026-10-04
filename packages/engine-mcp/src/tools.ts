import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  analyzePatternFit,
  classifyBuyBuild,
  classifyFinding,
  computeSchedule,
  CycleError,
  cypherTemplate,
  estimateProvenance,
  instantiateTasks,
  recommendStrategy,
  templateNames,
  type Thresholds,
} from '@planner/engine';

/** Input schemas mirror the engine's input types (DESIGN §2). Plain JSON in, JSON out. */

const id = z.string().min(1);
const nonNeg = z.number().min(0);
const weeks = { weeks_o: nonNeg, weeks_e: nonNeg, weeks_p: nonNeg };
const dependency = z.object({ from: id, to: id });

const schemas = {
  recommend_strategy: z.object({
    findings: z.array(
      z.object({ id, kind: z.string(), severity: z.string(), capability_type: z.string().optional() }),
    ),
    coverage: z.record(z.string(), z.number().min(0).max(1)),
  }),
  classify_finding: z.object({
    findings: z.array(z.object({ id, kind: z.string(), evidence_type: z.string(), confidence: z.number().min(0).max(1) })),
  }),
  analyze_pattern_fit: z.object({
    use_case: z.object({ use_case_id: id, description: z.string(), finding_texts: z.array(z.string()) }),
    deal_context: z.object({
      strategy: z.string(),
      target_company: z.string(),
      acquirer: z.string(),
      selected_patterns: z.array(id),
      flagged_rules: z.record(z.string(), z.array(z.string())).optional(),
    }),
    candidates: z.array(
      z.object({
        id,
        name: z.string(),
        description: z.string(),
        solves: z.array(id),
        strategies: z.array(z.string()),
        requires: z.array(id),
        not_recommended_when: z.array(z.string()),
      }),
    ),
  }),
  instantiate_tasks: z.object({
    deal: id,
    iteration: z.number().int().positive(),
    selections: z.array(
      z.object({
        uc: id,
        pattern: id,
        requires: z.array(id),
        tasks: z.array(z.object({ id, ...weeks, skill: z.string(), depends_on: z.array(id) })),
      }),
    ),
  }),
  compute_schedule: z.object({
    // loose: instantiate_tasks output (with uc, skill, ...) can be passed straight through
    plan_tasks: z.array(z.object({ id, ...weeks }).loose()),
    depends_on: z.array(dependency),
  }),
  estimate_provenance: z.object({
    task: z.object({ id, ...weeks }),
    observations: z.array(z.number().positive()),
    modifiers: z.array(z.object({ name: z.string(), factor: z.number().positive() })),
  }),
  classify_buy_build: z.object({
    rows: z.array(
      z.object({
        capability_id: id,
        integrate_effort: nonNeg.nullable(),
        build_effort: nonNeg,
        coverage: z.number().min(0).max(1),
      }),
    ),
  }),
  cypher_template: z.object({ name: z.string().optional() }),
};

const DESCRIPTIONS: Record<keyof typeof schemas, string> = {
  recommend_strategy:
    'Rank bridge vs transform for a deal from its classified findings and the acquirer coverage per capability type (DESIGN §2.1).',
  classify_finding:
    'Classify findings as gap, assumption, capability, risk, or service. Gaps and capabilities need strong evidence (DESIGN §2.1).',
  analyze_pattern_fit:
    'Score candidate patterns (retrieved by Cypher) for one framed use case: five signals, reuse penalty, band (DESIGN §2.2).',
  instantiate_tasks:
    'Turn selections into PlanTasks (<uc>:<task id>) and DEPENDS_ON edges, including REQUIRES links across selections (DESIGN §2.3).',
  compute_schedule:
    'Schedule PlanTasks: earliest_start, wave, critical path, PERT band. A cycle is returned as an error with its witness (DESIGN §2.3).',
  estimate_provenance: 'Explain an estimate: catalog baseline, history average, modifiers, result, and band (DESIGN §2.4).',
  classify_buy_build: 'Decide integrate, build, retire, or review per capability from BB1 rows (DESIGN §2.6).',
  cypher_template:
    'Get a standard write: {query, params_schema, destructive}. Without a name, list all templates (DESIGN §2.5).',
};

function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
}

function fail(error: unknown): CallToolResult {
  const body =
    error instanceof CycleError
      ? { error: 'cycle', message: error.message, witness: error.witness }
      : { error: 'invalid', message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** Builds the planner-engine MCP server. Pure: no file, network, or database access per call. */
export function createEngineServer(th: Thresholds): McpServer {
  const server = new McpServer({ name: 'planner-engine', version: '0.1.0' });

  const handlers: { [K in keyof typeof schemas]: (input: z.infer<(typeof schemas)[K]>) => unknown } = {
    recommend_strategy: (input) => recommendStrategy(input, th),
    classify_finding: ({ findings }) => findings.map((f) => ({ id: f.id, classified_as: classifyFinding(f, th) })),
    analyze_pattern_fit: (input) => analyzePatternFit(input, th),
    instantiate_tasks: (input) => instantiateTasks(input),
    compute_schedule: ({ plan_tasks, depends_on }) => computeSchedule(plan_tasks, depends_on),
    estimate_provenance: (input) => estimateProvenance(input, th),
    classify_buy_build: ({ rows }) => classifyBuyBuild(rows, th),
    cypher_template: ({ name }) =>
      name === undefined
        ? templateNames().map((n) => {
            const t = cypherTemplate(n);
            return { name: t.name, description: t.description, destructive: t.destructive };
          })
        : cypherTemplate(name),
  };

  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const handler = handlers[name] as (input: unknown) => unknown;
    server.registerTool(name, { description: DESCRIPTIONS[name], inputSchema: schemas[name] }, (input: unknown) => {
      try {
        return ok(handler(input));
      } catch (error) {
        return fail(error);
      }
    });
  }
  return server;
}

export const ENGINE_TOOL_NAMES = Object.keys(schemas);
