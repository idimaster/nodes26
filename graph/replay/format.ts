import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Replay recordings (T4.4, Tier 0): data/replays/<name>.jsonl. One header line, then the state-changing
 * MCP calls in order, then one decision per gate. Reads and pure engine calls are not recorded: they
 * change nothing, and replay re-runs everything that does.
 */

/** Tools whose calls change the graph (directly, or by waiting for a gate decision that does). */
export const STATEFUL: Record<string, string[]> = {
  'neo4j-write': ['write-cypher'],
  gate: ['request_approval', 'await_approval', 'resolve_feedback'],
  ontology: ['propose_term'],
  'planner-graph': ['schedule_plan'],
};
export const isStateful = (server: string, tool: string) => STATEFUL[server]?.includes(tool) ?? false;

export const expectSchema = z.object({
  /** Node count per label, over the whole graph. */
  counts: z.record(z.string(), z.number()),
  /** Relationship count per type, over the whole graph. */
  relationships: z.record(z.string(), z.number()),
  /** Validator verdicts per iteration of the deal: {"1": {"V1": "PASS", …}}. */
  verdicts: z.record(z.string(), z.record(z.string(), z.string())),
});
export type Expectations = z.infer<typeof expectSchema>;

export const headerSchema = z.object({
  kind: z.literal('header'),
  format: z.literal(1),
  deal: z.string(),
  /** live: recorded from a Claude Code session; skill-walk: from the scripted walk (no LLM). */
  source: z.enum(['live', 'skill-walk']),
  recorded_at: z.string(),
  expect: expectSchema,
});

export const callSchema = z.object({
  kind: z.literal('call'),
  seq: z.number().int(),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
});

export const decisionSchema = z.object({
  kind: z.literal('decision'),
  gate_id: z.string(),
  action: z.enum(['approve', 'approve_except', 'reject']),
  comment: z.string(),
  by: z.string(),
});

export type Header = z.infer<typeof headerSchema>;
export type Call = z.infer<typeof callSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export interface Recording {
  header: Header;
  calls: Call[];
  decisions: Decision[];
}

export function parseRecording(text: string): Recording {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const [first, ...rest] = lines;
  if (!first) throw new Error('empty recording');
  const header = headerSchema.parse(JSON.parse(first));
  const calls: Call[] = [];
  const decisions: Decision[] = [];
  rest.forEach((line, i) => {
    const o = JSON.parse(line) as { kind?: string };
    if (o.kind === 'call') calls.push(callSchema.parse(o));
    else if (o.kind === 'decision') decisions.push(decisionSchema.parse(o));
    else throw new Error(`line ${i + 2}: unknown kind ${String(o.kind)}`);
  });
  return { header, calls, decisions };
}

export const serializeRecording = (r: Recording) => [r.header, ...r.calls, ...r.decisions].map((x) => JSON.stringify(x)).join('\n') + '\n';

export const readRecording = (path: string) => parseRecording(readFileSync(path, 'utf8'));
export const writeRecording = (path: string, r: Recording) => writeFileSync(path, serializeRecording(r));
