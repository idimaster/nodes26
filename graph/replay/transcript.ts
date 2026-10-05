import { isStateful } from './format.js';

/**
 * Reads a Claude Code session transcript (~/.claude/projects/<project>/<session>.jsonl) and returns the
 * state-changing MCP calls with their results, in call order. Only tool arguments and results are kept:
 * no prompts, no assistant text. Failed calls (a guard denial, a tool error) are skipped, because they
 * changed nothing.
 */

const NAME = /^mcp__([a-z0-9-]+)__([A-Za-z0-9_-]+)$/;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TranscriptCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
      : '';

/** Our servers also send structuredContent `{result}`; Claude Code then records that instead of the text. */
const parseResult = (raw: string): unknown => {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'result' in v) return (v as { result: unknown }).result;
  return v;
};

export function callsFromTranscript(jsonl: string): TranscriptCall[] {
  const uses: { id: string; server: string; tool: string; args: Record<string, unknown> }[] = [];
  const results = new Map<string, { error: boolean; raw: string }>();
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // a torn last line in a live file
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b.type === 'tool_use' && b.id && b.name) {
        const m = NAME.exec(b.name);
        if (m && isStateful(m[1] as string, m[2] as string)) uses.push({ id: b.id, server: m[1] as string, tool: m[2] as string, args: (b.input ?? {}) as Record<string, unknown> });
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        results.set(b.tool_use_id, { error: b.is_error === true, raw: text(b.content) });
      }
    }
  }
  return uses.flatMap((u) => {
    const r = results.get(u.id);
    if (!r || r.error) return [];
    return [{ server: u.server, tool: u.tool, args: u.args, result: parseResult(r.raw) }];
  });
}
