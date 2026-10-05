import type { Driver } from 'neo4j-driver';
import { GateStore } from '@planner/gate';
import { loadContext, validate } from '@planner/guard';
import { loadAll } from '../load/index.js';
import type { Call, Decision, Recording } from './format.js';
import { startServers } from './servers.js';
import { diffExpectations, expectations } from './snapshot.js';

/**
 * Tier 0 replay (T4.4): re-executes a recording against the real MCP servers, with no LLM.
 * - Every write-cypher passes the write guard first, as the PreToolUse hook does live; a denial stops the replay.
 * - Gate decisions are made with GateStore.decide, the function the console's POST calls (addendum A4),
 *   while the tool waits, exactly as the architect did. Gate ids are deterministic, so they must match.
 * - At the end, graph counts and validator verdicts are compared with the recording's header.
 */

export class ReplayError extends Error {
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(`call ${seq}: ${message}`);
    this.name = 'ReplayError';
  }
}

export interface ReplayOptions {
  driver: Driver;
  root: string;
  /** Pause between calls, so the demo UI can be watched (default 0). */
  delayMs?: number;
  log?: (line: string) => void;
}

export interface ReplayReport {
  ok: boolean;
  calls: number;
  /** Calls whose result differs from the recorded one (writes only; informational). */
  resultMismatches: number[];
  /** Expected vs actual counts and verdicts; empty when the replay reproduced the run. */
  differences: string[];
}

const GATE_WAITING = new Set(['request_approval', 'await_approval', 'propose_term']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateOf = (result: unknown) => {
  const r = result as { gate_id?: unknown; status?: unknown } | null;
  return r && typeof r.gate_id === 'string' ? { id: r.gate_id, status: String(r.status) } : null;
};

/** Plays the architect: once the gate is pending, decides it as recorded. */
async function architect(store: GateStore, deal: string, d: Decision, seq: number, done: () => boolean) {
  for (let i = 0; i < 600 && !done(); i++) {
    const pending = await store.listGates('pending', deal);
    if (pending.some((g) => g.id === d.gate_id)) {
      await store.decide(d.gate_id, { action: d.action, comment: d.comment, by: d.by });
      return;
    }
    const current = await store.getResult(d.gate_id);
    if (current && current.status !== 'pending') return; // already decided
    await sleep(100);
  }
  if (!done()) throw new ReplayError(seq, `gate ${d.gate_id} never became pending`);
}

export async function replay(rec: Recording, opts: ReplayOptions): Promise<ReplayReport> {
  const { driver, log = () => undefined } = opts;
  const { deal } = rec.header;
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);

  const used = [...new Set(rec.calls.map((c) => c.server))];
  const servers = await startServers(opts.root, { GATE_HTTP: 'off', GATE_WAIT_SECONDS: '30' }, used);
  const store = new GateStore(driver);
  const decisions = new Map(rec.decisions.map((d) => [d.gate_id, d]));
  const decided = new Set<string>();
  const resultMismatches: number[] = [];

  const play = async (c: Call) => {
    if (c.server === 'neo4j-write' && c.tool === 'write-cypher') {
      const query = String(c.args.query ?? '');
      const params = (c.args.params ?? {}) as Record<string, unknown>;
      const verdict = await validate(query, params, await loadContext(driver, params.deal as string | undefined));
      if (!verdict.allow) throw new ReplayError(c.seq, `the guard denied a recorded write: ${verdict.reason}`);
    }
    const recordedGate = gateOf(c.result);
    const decision = GATE_WAITING.has(c.tool) && recordedGate && recordedGate.status !== 'pending' ? decisions.get(recordedGate.id) : undefined;
    if (GATE_WAITING.has(c.tool) && recordedGate && recordedGate.status !== 'pending' && !decision && !decided.has(recordedGate.id)) {
      throw new ReplayError(c.seq, `the recording has no decision for gate ${recordedGate.id}`);
    }
    let finished = false;
    const deciding = decision && !decided.has(decision.gate_id) ? architect(store, deal, decision, c.seq, () => finished) : undefined;
    let result: unknown;
    try {
      result = await servers.call(c.server, c.tool, c.args);
    } catch (e) {
      throw new ReplayError(c.seq, e instanceof Error ? e.message : String(e));
    } finally {
      finished = true;
    }
    await deciding;
    if (decision) decided.add(decision.gate_id);

    if (recordedGate) {
      const got = gateOf(result);
      if (got?.id !== recordedGate.id || got.status !== recordedGate.status) {
        throw new ReplayError(c.seq, `${c.tool}: expected gate ${recordedGate.id} ${recordedGate.status}, got ${got?.id ?? 'none'} ${got?.status ?? ''}`);
      }
    } else if (JSON.stringify(result) !== JSON.stringify(c.result)) {
      resultMismatches.push(c.seq);
    }
    log(`${String(c.seq).padStart(3)} ${c.server}.${c.tool}${recordedGate ? ` ${recordedGate.id} ${recordedGate.status}` : ''}`);
  };

  try {
    for (const c of rec.calls) {
      await play(c);
      if (opts.delayMs) await sleep(opts.delayMs);
    }
  } finally {
    await servers.close();
  }
  const differences = diffExpectations(rec.header.expect, await expectations(driver, deal));
  return { ok: differences.length === 0, calls: rec.calls.length, resultMismatches, differences };
}
