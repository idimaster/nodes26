import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContext, validate } from '@planner/guard';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/**
 * T2.6, without an LLM: walk the plan-integration skill for Nimbus through the real MCP servers,
 * with the skill's own named queries, every write checked by the guard first, and gates approved in
 * the console over HTTP. The LLM's choices (framing, picking the top candidate) are fixed here.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILL = readFileSync(join(ROOT, 'plugin/skills/plan-integration/SKILL.md'), 'utf8');
const QUERIES = Object.fromEntries(
  [...SKILL.matchAll(/<!-- query: (\w+) -->\s*```cypher\n([\s\S]*?)```/g)].map((m) => [m[1] as string, (m[2] as string).trim()]),
);
const MCP = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as {
  mcpServers: Record<string, { command: string; args?: string[] }>;
};
const DEAL = 'nimbus';

let driver: Driver;
let port = 0;
const clients: Record<string, Client> = {};
const log: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content.map((c) => c.text).join('\n'));
async function call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await (clients[server] as Client).callTool({ name: tool, arguments: args });
  if (r.isError) throw new Error(`${server}.${tool} failed: ${text(r)}`);
  log.push(`${server}.${tool}`);
  return JSON.parse(text(r));
}
const read = async <T = Record<string, unknown>>(name: string, params: Record<string, unknown> = {}) =>
  (await call('neo4j-read', 'read-cypher', { query: QUERIES[name], params: { deal: DEAL, ...params } })) as T[];

/** Rule 1 + 2 of the skill: template → guard → write-cypher → compare the count. */
async function write(template: string, params: Record<string, unknown>) {
  const { query } = (await call('planner-engine', 'cypher_template', { name: template })) as { query: string };
  const decision = await validate(query, params, await loadContext(driver, DEAL));
  expect(decision, `guard on ${template}: ${decision.allow ? '' : decision.reason}`).toEqual({ allow: true });
  const rows = (await call('neo4j-write', 'write-cypher', { query, params })) as Record<string, unknown>[];
  return rows[0] ?? {};
}

/** Rule 4: request, and approve as the architect in the console while the agent waits. */
async function gate(gateKind: string, iteration: number, subjects: string[], summary: string) {
  const pending = call('gate', 'request_approval', { deal: DEAL, iteration, gate: gateKind, subject_ids: subjects, summary });
  let id: string | undefined;
  for (let i = 0; i < 40 && !id; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const gates = (await (await fetch(`http://127.0.0.1:${port}/api/gates?status=pending`)).json()) as { id: string; gate: string }[];
    id = gates.find((g) => g.gate === gateKind)?.id;
  }
  expect(id, `the ${gateKind} gate appears in the console`).toBeDefined();
  const res = await fetch(`http://127.0.0.1:${port}/api/gates/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', comment: '', by: 'architect' }),
  });
  expect(res.status).toBe(200);
  const result = (await pending) as { status: string; gate_id: string };
  expect(result.status).toBe('approved');
  return result.gate_id;
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  port = await freePort();
  for (const [name, entry] of Object.entries(MCP.mcpServers)) {
    const client = new Client({ name: `walk-${name}`, version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), GATE_PORT: String(port), GATE_WAIT_SECONDS: '5' },
        stderr: 'ignore',
      }),
    );
    clients[name] = client;
  }
}, 60_000);

afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('the plan-integration skill, walked for Nimbus (T2.6)', () => {
  it('has every named query the steps refer to', () => {
    for (const q of ['findings', 'coverage', 'next_iteration', 'use_cases', 'candidates', 'pattern_tasks', 'plan_graph', 'next_roadmap_version']) {
      expect(QUERIES[q], q).toBeTruthy();
      expect(SKILL).toContain(`\`${q}\``);
    }
  });

  it('reaches a committed roadmap', async () => {
    // 1. Ground
    expect(text(await (clients['neo4j-read'] as Client).callTool({ name: 'get-schema', arguments: {} }))).toContain('Finding');
    const findings = await read<{ id: string; kind: string; text: string; severity: string; confidence: number; evidence_type: string; capability_type: string | null; target_company: string; acquirer: string }>('findings');
    expect(findings.length).toBe(25);
    const coverage = Object.fromEntries((await read<{ capability_type: string; coverage: number }>('coverage')).map((c) => [c.capability_type, c.coverage]));
    const [{ n: iteration }] = (await read<{ n: number }>('next_iteration')) as [{ n: number }];
    expect(iteration).toBe(1);

    // 2. Classify
    const classified = (await call('planner-engine', 'classify_finding', { findings })) as { id: string; classified_as: string }[];
    expect(Number((await write('classify_findings', { deal: DEAL, rows: classified })).classified)).toBe(25);

    // 3. Strategy
    const byId = new Map(classified.map((c) => [c.id, c.classified_as]));
    const [strategy] = (await call('planner-engine', 'recommend_strategy', {
      findings: findings.map((f) => ({ id: f.id, kind: byId.get(f.id), severity: f.severity, ...(f.capability_type ? { capability_type: f.capability_type } : {}) })),
      coverage,
    })) as { strategy: string; fit_score: number; rationale: string }[];
    expect(strategy?.strategy).toBe('bridge');

    // 4. Frame (the LLM's choice, fixed here)
    await write('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
    const framings = [
      { use_case_id: 'user-provisioning', finding_ids: ['f-no-scim'] },
      { use_case_id: 'ledger-data-sync', finding_ids: ['f-ledger-sync'] },
      { use_case_id: 'customer-sso', finding_ids: ['f-customer-sso'] },
      { use_case_id: 'audit-logging', finding_ids: ['f-audit-store'] },
    ];
    const framed = await write('write_framed_use_cases', {
      deal: DEAL,
      iteration,
      rows: framings.map((f) => ({ ...f, framing_rationale: `Framed from ${f.finding_ids.join(', ')}.` })),
    });
    expect(Number(framed.framed)).toBe(framings.length);
    await gate('frame', iteration, framings.map((f) => `FramedUseCase:${f.use_case_id}`), `Strategy ${strategy?.strategy} (${strategy?.fit_score}).`);
    await write('set_deal_strategy', { deal: DEAL, strategy: strategy?.strategy });

    // 5. Retrieve and score
    const useCases = new Map((await read<{ id: string; description: string }>('use_cases')).map((u) => [u.id, u.description]));
    const top = new Map<string, { pattern: string; score: number }>();
    for (const f of framings) {
      const candidates = await read('candidates', { use_case: f.use_case_id });
      const ranked = (await call('planner-engine', 'analyze_pattern_fit', {
        use_case: {
          use_case_id: f.use_case_id,
          description: useCases.get(f.use_case_id),
          finding_texts: f.finding_ids.map((id) => findings.find((x) => x.id === id)?.text ?? ''),
        },
        deal_context: { strategy: strategy?.strategy, target_company: findings[0]?.target_company, acquirer: findings[0]?.acquirer, selected_patterns: [] },
        candidates,
      })) as { pattern: string; score: number; band: string; signals: unknown }[];
      const rows = ranked.slice(0, 3).map((r) => ({ uc: f.use_case_id, pattern: r.pattern, fit_score: r.score, band: r.band, signal_snapshot: JSON.stringify(r.signals) }));
      expect(Number((await write('write_candidates', { deal: DEAL, iteration, rows })).candidates)).toBe(rows.length);
      top.set(f.use_case_id, { pattern: ranked[0]?.pattern as string, score: ranked[0]?.score as number });
    }
    expect(top.get('user-provisioning')?.pattern).toBe('scim-provisioning');
    expect(top.get('ledger-data-sync')?.pattern).toBe('cdc-replication');

    // 6. Select (the LLM takes the top candidate) and the select gate
    const selections = [...top].map(([uc, t]) => ({ uc, pattern: t.pattern, fit_score: t.score, rationale: 'Highest fit score.' }));
    expect(Number((await write('write_selections', { deal: DEAL, iteration, rows: selections })).selections)).toBe(selections.length);
    await gate('select', iteration, selections.map((s) => `Selection:${s.uc}`), selections.map((s) => `${s.uc}: ${s.pattern} (${s.fit_score})`).join('; '));

    // 7. Instantiate: the graph derives tasks and edges from the catalog
    const patternTasks = await read<{ pattern: string; tasks: unknown[] }>('pattern_tasks', { patterns: selections.map((s) => s.pattern) });
    const expectedTasks = selections.reduce((n, s) => n + (patternTasks.find((p) => p.pattern === s.pattern)?.tasks.length ?? 0), 0);
    const planWrite = await write('write_plan_tasks', { deal: DEAL, iteration });
    expect(Number(planWrite.tasks)).toBe(expectedTasks);

    // 8. Schedule what is stored, exactly as stored
    const [plan] = (await read<{ plan_tasks: { id: string }[]; depends_on: { from: string; to: string }[] }>('plan_graph', { iteration })) as [
      { plan_tasks: { id: string }[]; depends_on: { from: string; to: string }[] },
    ];
    expect(plan.plan_tasks).toHaveLength(expectedTasks);
    expect(plan.depends_on).toHaveLength(Number(planWrite.edges));
    const schedule = (await call('planner-engine', 'compute_schedule', plan)) as {
      tasks: unknown[];
      finish: number;
      critical_path: string[];
      pert: { p10: number; p90: number };
    };
    expect(Number((await write('write_schedule', { deal: DEAL, iteration, rows: schedule.tasks })).scheduled)).toBe(expectedTasks);

    // 9. Commit
    const [{ version }] = (await read<{ version: number }>('next_roadmap_version')) as [{ version: number }];
    const commitGate = await gate(
      'commit',
      iteration,
      [...selections.map((s) => `Selection:${s.uc}`), `Iteration:${iteration}`],
      `Finish week ${schedule.finish}; PERT ${schedule.pert.p10}–${schedule.pert.p90}; critical path ${schedule.critical_path.join(' → ')}.`,
    );
    const committed = await write('commit_roadmap', { deal: DEAL, iteration, version, gate_id: commitGate });
    expect(Number(committed.included)).toBe(selections.length);

    // The record: a committed roadmap backed by an approved commit gate, and nothing left in draft.
    const { records } = await driver.executeQuery(
      `MATCH (r:Roadmap {deal_code: $deal, version: 1})-[:INCLUDES]->(s:Selection)
       MATCH (g:GateDecision {id: r.gate_id})
       RETURN r.status AS roadmap, g.gate AS gate, g.status AS gate_status, collect(DISTINCT s.status) AS selections,
              COUNT { MATCH (n {deal_code: $deal, iteration: 1}) WHERE n.status = 'draft' RETURN n } AS drafts`,
      { deal: DEAL },
    );
    expect(records[0]?.toObject()).toEqual({
      roadmap: 'committed',
      gate: 'commit',
      gate_status: 'approved',
      selections: ['committed'],
      drafts: expect.objectContaining({ low: 0 }),
    });
  }, 120_000);
});
