import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const WRITE_TOOL = 'mcp__neo4j-write__write-cypher';
export const CANONICAL = /^mcp__([a-z0-9-]+)__([a-zA-Z0-9_-]+)$/;
const server = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }).strict();
const config = z.object({ mcpServers: z.record(z.string(), server) }).strict();

export function plannerDefinition(root: string) {
  const agent = readFileSync(join(root, 'plugin/agents/planner.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(agent);
  if (!match) throw new Error('planner definition requires frontmatter and instructions');
  const lines = match[1]?.split(/\r?\n/).filter(line => /^tools:/.test(line)) ?? [];
  if (lines.length !== 1) throw new Error('planner definition requires one nonempty tool allowlist');
  const tools = (lines[0] ?? '').slice('tools:'.length).split(',').map(t => t.trim());
  if (!tools.length || tools.some(t => !CANONICAL.test(t)) || new Set(tools).size !== tools.length || !tools.includes(WRITE_TOOL)) {
    throw new Error('planner allowlist must contain unique valid names and the write binding');
  }
  const instructions = (match[2] ?? '').trim();
  if (!instructions) throw new Error('planner definition requires nonempty instructions');
  return { instructions, tools };
}

export function gatewayDefinition(root: string) {
  const definition = plannerDefinition(root);
  const servers = config.parse(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).mcpServers;
  // The official server gives CLI identity flags precedence over environment settings.
  // Keep its checked-in wrappers/modes fixed so no argv can split guard and writer graphs.
  for (const [name, mode] of [['neo4j-read', 'true'], ['neo4j-write', 'false']] as const) {
    const entry = servers[name];
    if (!entry || entry.command !== 'scripts/neo4j-mcp.sh' || JSON.stringify(entry.args) !== JSON.stringify(['--read-only', mode])) {
      throw new Error(`${name}: require the repository Neo4j MCP wrapper and fixed --read-only mode; graph CLI overrides are unsupported`);
    }
  }
  for (const name of definition.tools) {
    const source = CANONICAL.exec(name)?.[1];
    if (!source || !Object.hasOwn(servers, source)) throw new Error(`unknown server in allowlist: ${name}`);
  }
  return { ...definition, servers };
}
