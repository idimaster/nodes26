import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';

/** T2.4: the PreToolUse adapter, run as Claude Code runs it (JSON on stdin), against the real graph. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const HOOK = join(ROOT, 'packages/guard/bin/guard-hook.ts');
const TOOL = 'mcp__neo4j-write__write-cypher';
const LOG = join(mkdtempSync(join(tmpdir(), 'guard-')), 'guard.jsonl');

function hook(input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(TSX, [HOOK], {
    cwd: ROOT,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, GUARD_LOG: LOG, ...env },
    encoding: 'utf8',
  });
  const out = r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> }) : null;
  return { status: r.status, out, stderr: r.stderr };
}

const call = (query: string, params: Record<string, unknown>) => ({
  session_id: 's',
  hook_event_name: 'PreToolUse',
  tool_name: TOOL,
  tool_input: { query, params },
});

const COMMIT = "MATCH (s:Selection {deal_code: $deal, iteration: $iteration}) SET s.status = 'committed' RETURN count(s) AS n";

describe('guard-hook (PreToolUse adapter)', () => {
  let driver: Driver;

  beforeAll(async () => {
    driver = openDriver();
    await driver.executeQuery(
      `MERGE (g1:GateDecision {id: 'gd-hook-ok'})
       SET g1 += {deal_code: 'nimbus', iteration: 7, gate: 'commit', status: 'approved', comment: '', by: 'test', at: datetime()}
       MERGE (g2:GateDecision {id: 'gd-hook-pending'})
       SET g2 += {deal_code: 'nimbus', iteration: 7, gate: 'commit', status: 'pending', comment: '', by: 'test', at: datetime()}
       MERGE (t1:OntologyTerm {kind: 'label', name: 'DataResidencyRequirement'})
       SET t1 += {scope: 'nimbus', status: 'active', definition: 'd', example: 'e', version: 1}
       MERGE (t2:OntologyTerm {kind: 'label', name: 'HookProposedOnly'})
       SET t2 += {scope: 'nimbus', status: 'proposed', definition: 'd', example: 'e', version: 1}
       RETURN 1`,
    );
  });

  afterAll(async () => {
    await driver.executeQuery(
      `MATCH (n) WHERE (n:GateDecision AND n.id STARTS WITH 'gd-hook-')
         OR (n:OntologyTerm AND n.name IN ['DataResidencyRequirement', 'HookProposedOnly'])
       DETACH DELETE n`,
    );
    await driver.close();
  });

  it('ignores other tools (no output, so normal permissions apply)', () => {
    const r = hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__neo4j-read__read-cypher', tool_input: { query: 'MATCH (n) DETACH DELETE n' } });
    expect([r.status, r.out]).toEqual([0, null]);
  });

  it('stays silent on an allowed write', () => {
    const r = hook(call('MATCH (s:Selection {deal_code: $deal}) SET s.rationale = $r RETURN count(s) AS n', { deal: 'nimbus', r: 'x' }));
    expect([r.status, r.out]).toEqual([0, null]);
  });

  it('denies with Claude Code hook output and an actionable reason', () => {
    const r = hook(call('MATCH (g:GateDecision) RETURN g', { deal: 'nimbus' }));
    expect(r.status).toBe(0);
    expect(r.out?.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringMatching(/^Write guard denied this query\.\nG7: label GateDecision is reserved/),
    });
  });

  it('G8 against real GateDecision nodes: approved commit gate allows, pending denies', () => {
    expect(hook(call(COMMIT, { deal: 'nimbus', iteration: 7, gate_id: 'gd-hook-ok' })).out).toBeNull();
    const pending = hook(call(COMMIT, { deal: 'nimbus', iteration: 7, gate_id: 'gd-hook-pending' }));
    expect(pending.out?.hookSpecificOutput?.permissionDecisionReason).toMatch(/G8: gate gd-hook-pending is pending/);
    const wrongIteration = hook(call(COMMIT, { deal: 'nimbus', iteration: 8, gate_id: 'gd-hook-ok' }));
    expect(wrongIteration.out?.hookSpecificOutput?.permissionDecisionReason).toMatch(/G8: .*iteration 7, not 8/);
  });

  it('G6 against real OntologyTerm nodes: active deal term allows, proposed term and other deal deny', () => {
    const q = 'MERGE (r:DataResidencyRequirement {deal_code: $deal, id: $id}) RETURN r.id AS id';
    expect(hook(call(q, { deal: 'nimbus', id: 'x' })).out).toBeNull();
    expect(hook(call(q, { deal: 'tidewater', id: 'x' })).out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const proposed = hook(call('MERGE (r:HookProposedOnly {deal_code: $deal, id: $id}) RETURN r.id AS id', { deal: 'nimbus', id: 'x' }));
    expect(proposed.out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('fails closed when Neo4j is unreachable', () => {
    const r = hook(call('MATCH (s:Selection {deal_code: $deal}) RETURN s', { deal: 'nimbus' }), { NEO4J_URI: 'bolt://localhost:1' });
    expect(r.out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.out?.hookSpecificOutput?.permissionDecisionReason).toMatch(/fails closed/);
  });

  it('fails closed on input it cannot read', () => {
    const notJson = hook('not json');
    expect(notJson.out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const noQuery = hook({ hook_event_name: 'PreToolUse', tool_name: TOOL, tool_input: {} });
    expect(noQuery.out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('logs every decision, allow or deny, as one JSON line', () => {
    expect(existsSync(LOG)).toBe(true);
    const lines = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines.some((l) => l.allow === true)).toBe(true);
    expect(lines.find((l) => l.allow === false)).toMatchObject({ tool: TOOL, rules: expect.any(Array), reason: expect.any(String) });
  });
});
