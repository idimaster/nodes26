import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { loadContext } from '../src/neo4j-context.js';
import { validate, type Decision } from '../src/validate.js';

/**
 * Claude Code PreToolUse adapter for the write guard (DESIGN §3).
 * - Another tool: no output, so the normal permission flow applies.
 * - Allowed write: no output (the guard never auto-approves; your permission settings still apply).
 * - Denied write: hookSpecificOutput with permissionDecision 'deny' and the reason, which the agent sees.
 * It fails closed: unreadable input or an unreachable graph is a deny.
 */

const LOG = process.env.GUARD_LOG ?? fileURLToPath(new URL('../../../.logs/guard.jsonl', import.meta.url));
const GUARDED = /__write-cypher$/;

interface HookInput {
  tool_name?: unknown;
  tool_input?: { query?: unknown; params?: unknown };
}

function log(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (e) {
    console.error(`guard-hook: cannot write log ${LOG}: ${String(e)}`);
  }
}

function deny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Write guard denied this query.\n${reason}`,
      },
    }),
  );
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    log({ allow: false, rules: ['PARSE'], reason: 'hook input is not JSON' });
    deny('PARSE: the hook input is not JSON; the guard fails closed.');
    return;
  }
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!GUARDED.test(tool)) return;

  const query = input.tool_input?.query;
  const params = (input.tool_input?.params ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string' || typeof params !== 'object' || params === null || Array.isArray(params)) {
    log({ tool, allow: false, rules: ['PARSE'], reason: 'tool_input has no query string or params object' });
    deny('PARSE: write-cypher needs {query: string, params: object}; the guard fails closed.');
    return;
  }

  const deal = typeof params.deal === 'string' ? params.deal : undefined;
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'neo4j://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'planner-demo'),
    { connectionAcquisitionTimeout: 5000, connectionTimeout: 5000, maxTransactionRetryTime: 2000 },
  );
  let decision: Decision;
  try {
    decision = await validate(query, params, await loadContext(driver, deal));
  } catch (e) {
    const reason = `the guard cannot read the graph (${e instanceof Error ? e.message : String(e)}); it fails closed`;
    log({ tool, deal, allow: false, rules: ['CONTEXT'], reason, query: query.slice(0, 2000) });
    deny(reason);
    return;
  } finally {
    await driver.close();
  }

  if (decision.allow) {
    log({ tool, deal, allow: true, query: query.slice(0, 2000) });
    return;
  }
  log({ tool, deal, allow: false, rules: decision.violations.map((v) => v.rule), reason: decision.reason, query: query.slice(0, 2000) });
  deny(decision.reason);
}

main().catch((e: unknown) => {
  deny(`internal error (${e instanceof Error ? e.message : String(e)}); the guard fails closed`);
});
