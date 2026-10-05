import { describe, expect, it } from 'vitest';
import { parseRecording, serializeRecording, type Recording } from '../../graph/replay/format.js';
import { callsFromTranscript } from '../../graph/replay/transcript.js';

/** T4.4: reading a Claude Code transcript into replayable calls, and the recording format. */

const line = (role: 'assistant' | 'user', content: unknown[]) => JSON.stringify({ type: role, message: { role, content } });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, text: string, is_error = false) => ({ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] });

const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan the Nimbus integration.' } }),
  line('assistant', [{ type: 'text', text: 'Reading findings.' }, use('t1', 'mcp__neo4j-read__read-cypher', { query: 'MATCH (f) RETURN f' })]),
  line('user', [result('t1', '[]')]),
  line('assistant', [use('t2', 'mcp__neo4j-write__write-cypher', { query: 'MERGE (i:Iteration …) RETURN i', params: { deal: 'nimbus' } })]),
  line('user', [result('t2', '[{"n":1}]')]),
  // Denied by the guard hook: changed nothing, so it is not replayed.
  line('assistant', [use('t3', 'mcp__neo4j-write__write-cypher', { query: 'MATCH (n) DETACH DELETE n', params: {} })]),
  line('user', [result('t3', 'PreToolUse hook blocked: G2', true)]),
  line('assistant', [use('t4', 'mcp__planner-engine__analyze_pattern_fit', {}), use('t5', 'mcp__gate__request_approval', { deal: 'nimbus', iteration: 1, gate: 'frame' })]),
  line('user', [result('t4', '[]'), result('t5', '{"result":{"status":"approved","gate_id":"gd-nimbus-1-frame-1","feedback_ids":[],"overrides":[]}}')]),
  // A call whose result never arrived (the session ended) is dropped.
  line('assistant', [use('t6', 'mcp__planner-graph__schedule_plan', { deal: 'nimbus', iteration: 1 })]),
  '{"torn',
].join('\n');

describe('callsFromTranscript', () => {
  it('keeps the state-changing MCP calls that succeeded, in order, with parsed (and unwrapped structured) results', () => {
    expect(callsFromTranscript(TRANSCRIPT)).toEqual([
      { server: 'neo4j-write', tool: 'write-cypher', args: { query: 'MERGE (i:Iteration …) RETURN i', params: { deal: 'nimbus' } }, result: [{ n: 1 }] },
      {
        server: 'gate',
        tool: 'request_approval',
        args: { deal: 'nimbus', iteration: 1, gate: 'frame' },
        result: { status: 'approved', gate_id: 'gd-nimbus-1-frame-1', feedback_ids: [], overrides: [] },
      },
    ]);
  });
  it('keeps no prompt or assistant text', () => {
    expect(JSON.stringify(callsFromTranscript(TRANSCRIPT))).not.toMatch(/Plan the Nimbus|Reading findings/);
  });
});

describe('recording format', () => {
  it('round-trips, and rejects unknown lines', () => {
    const r: Recording = {
      header: { kind: 'header', format: 1, deal: 'nimbus', source: 'live', recorded_at: '2026-10-05T00:00:00Z', expect: { counts: { Pattern: 29 }, relationships: {}, verdicts: { '1': { V1: 'PASS' } } } },
      calls: [{ kind: 'call', seq: 1, server: 'gate', tool: 'request_approval', args: {}, result: null }],
      decisions: [{ kind: 'decision', gate_id: 'gd-nimbus-1-frame-1', action: 'approve', comment: '', by: 'architect' }],
    };
    expect(parseRecording(serializeRecording(r))).toEqual(r);
    expect(() => parseRecording(`${serializeRecording(r)}{"kind":"chat"}\n`)).toThrow(/unknown kind/);
  });
});
