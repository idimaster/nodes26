import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Tool-surface check (T2.6, gotcha 03). The agent's tools must line up in three places:
 *   tools named in the skill  =  tools granted to the agent  ⊆  tools served by .mcp.json servers
 * and every served write tool must be covered by the guard hook.
 */

export interface Surface {
  skillTools: string[];
  agentTools: string[];
  /** server name → tool names it serves */
  served: Record<string, string[]>;
  /** PreToolUse matchers that run the guard */
  hookMatchers: string[];
}

const TOOL = /mcp__([a-z0-9-]+)__([a-z0-9_-]+)/g;
const WRITE_TOOL = /__write-cypher$/;

export const skillToolNames = (text: string): string[] => [...new Set([...text.matchAll(TOOL)].map((m) => m[0]))].sort();

export function agentToolNames(markdown: string): string[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  const line = /^tools:\s*(.*)$/m.exec(front)?.[1] ?? '';
  return line
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function checkSurface(s: Surface): string[] {
  const problems: string[] = [];
  const skill = new Set(s.skillTools);
  const granted = new Set(s.agentTools.filter((t) => t.startsWith('mcp__')));
  const served = new Set(Object.entries(s.served).flatMap(([server, tools]) => tools.map((t) => `mcp__${server}__${t}`)));

  for (const t of skill) if (!granted.has(t)) problems.push(`${t} is used by the skill but not granted to the agent`);
  for (const t of granted) if (!skill.has(t)) problems.push(`${t} is granted to the agent but not used by the skill`);
  for (const t of granted) if (!served.has(t)) problems.push(`${t} is granted but not served by any .mcp.json server`);

  const matchers = s.hookMatchers.map((m) => new RegExp(`^(?:${m})$`));
  s.hookMatchers.forEach((m, i) => {
    if (![...served].some((t) => matchers[i]?.test(t))) problems.push(`hook matcher ${JSON.stringify(m)} matches no served tool`);
  });
  for (const t of served) {
    if (WRITE_TOOL.test(t) && !matchers.some((m) => m.test(t))) problems.push(`${t} is not guarded: no PreToolUse hook matches it`);
  }
  return problems;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Launches every .mcp.json server and lists its tools. */
export async function servedTools(root = ROOT): Promise<Record<string, string[]>> {
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  };
  const out: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(mcp.mcpServers)) {
    const client = new Client({ name: 'check-tool-surface', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        cwd: root,
        // A spare port so the check never fights a running gate console.
        env: { ...(process.env as Record<string, string>), GATE_PORT: process.env.CHECK_GATE_PORT ?? '46499', ...(entry.env ?? {}) },
        stderr: 'ignore',
      }),
    );
    out[name] = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
  }
  return out;
}

export interface Paths {
  skill: string;
  agent: string;
  settings: string;
}

export const DEFAULT_PATHS: Paths = {
  skill: 'plugin/skills/plan-integration/SKILL.md',
  agent: 'plugin/agents/planner.md',
  settings: '.claude/settings.json',
};

export async function runCheck(root = ROOT, paths: Paths = DEFAULT_PATHS): Promise<string[]> {
  const settings = JSON.parse(readFileSync(join(root, paths.settings), 'utf8')) as {
    hooks?: { PreToolUse?: { matcher: string }[] };
  };
  return checkSurface({
    skillTools: skillToolNames(readFileSync(join(root, paths.skill), 'utf8')),
    agentTools: agentToolNames(readFileSync(join(root, paths.agent), 'utf8')),
    served: await servedTools(root),
    hookMatchers: (settings.hooks?.PreToolUse ?? []).map((h) => h.matcher),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheck()
    .then((problems) => {
      if (problems.length > 0) {
        console.error(`tool surface: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
        process.exit(1);
      }
      console.log('tool surface: skill = agent ⊆ served, and every write tool is guarded');
    })
    .catch((e: unknown) => {
      console.error(`tool surface: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
