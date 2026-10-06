import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, ToolLoopAgent, type LanguageModel, type Tool, type ToolSet } from 'ai';
import type { Driver } from 'neo4j-driver';
import { loadContext, validate } from '@planner/guard';

/**
 * Optional (T5.3): the planner agent on the AI SDK instead of Claude Code. Same skill text, same MCP
 * servers (.mcp.json), same tool allowlist (plugin/agents/planner.md), and write-cypher behind the same
 * write guard, called in-process here because there is no Claude Code hook. The gate server is unchanged:
 * the architect approves in the demo UI.
 */

const WRITE_TOOL = 'mcp__neo4j-write__write-cypher';

/** PLANNER_MODEL=anthropic:<model id> | openai-compatible:<model id> (experimental). */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const spec = env.PLANNER_MODEL ?? 'anthropic:claude-sonnet-5-5';
  const [provider, ...rest] = spec.split(':');
  const id = rest.join(':');
  if (!id) throw new Error(`PLANNER_MODEL must look like anthropic:<model id>, got ${spec}`);
  if (provider === 'anthropic') {
    return createAnthropic({ ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) })(id);
  }
  if (provider === 'openai-compatible') {
    const baseURL = env.OPENAI_COMPATIBLE_BASE_URL;
    if (!baseURL) throw new Error('openai-compatible models need OPENAI_COMPATIBLE_BASE_URL (and usually OPENAI_COMPATIBLE_API_KEY)');
    return createOpenAICompatible({ name: 'openai-compatible', baseURL, ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {}) })(id);
  }
  throw new Error(`unknown provider ${provider ?? ''} in PLANNER_MODEL (use anthropic or openai-compatible)`);
}

const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

/**
 * The agent's prompt and tool allowlist, from the Claude Code plugin, so both hosts run the same agent.
 * The agent body already embeds the full skill (npm run skill:sync).
 */
export function plannerDefinition(root: string) {
  const agent = readFileSync(join(root, 'plugin/agents/planner.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---/.exec(agent)?.[1] ?? '';
  const tools = (/^tools:\s*(.*)$/m.exec(front)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return { instructions: body(agent), tools };
}

/** Runs the write guard before write-cypher, as the PreToolUse hook does in Claude Code. A denial is returned to the model. */
export function guardWrites(tools: ToolSet, driver: Driver): ToolSet {
  const write = tools[WRITE_TOOL];
  if (!write?.execute) return tools;
  const execute = write.execute.bind(write);
  const guarded: Tool = {
    ...write,
    execute: async (input: { query?: string; params?: Record<string, unknown> }, options) => {
      const params = input.params ?? {};
      const decision = await validate(input.query ?? '', params, await loadContext(driver, params.deal as string | undefined));
      if (!decision.allow) return { denied: true, reason: decision.reason };
      return execute(input, options);
    },
  } as Tool;
  return { ...tools, [WRITE_TOOL]: guarded };
}

export interface Planner {
  agent: ToolLoopAgent<never, ToolSet>;
  tools: string[];
  close: () => Promise<void>;
}

/** Connects to every .mcp.json server, keeps the agent's allowlisted tools, and builds the agent. */
export async function createPlanner(opts: { root: string; driver: Driver; model: LanguageModel; maxSteps?: number; env?: Record<string, string> }): Promise<Planner> {
  const { instructions, tools: allowed } = plannerDefinition(opts.root);
  const mcp = JSON.parse(readFileSync(join(opts.root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args?: string[] }> };
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  try {
    for (const [server, entry] of Object.entries(mcp.mcpServers)) {
      const client = await createMCPClient({
        transport: new StdioMCPTransport({
          command: entry.command,
          args: entry.args ?? [],
          cwd: opts.root,
          env: { ...(process.env as Record<string, string>), ...opts.env },
          stderr: 'ignore',
        }),
      });
      clients.push(client);
      for (const [name, t] of Object.entries(await client.tools())) {
        const full = `mcp__${server}__${name}`; // the names the skill and the allowlist use
        if (allowed.includes(full)) tools[full] = t as Tool;
      }
    }
  } catch (e) {
    for (const c of clients) await c.close();
    throw e;
  }
  const missing = allowed.filter((t) => !(t in tools));
  if (missing.length > 0) {
    for (const c of clients) await c.close();
    throw new Error(`allowlisted tools not served: ${missing.join(', ')} (run npm run check:tools)`);
  }
  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions,
    tools: guardWrites(tools, opts.driver),
    stopWhen: stepCountIs(opts.maxSteps ?? 200),
  });
  return {
    agent,
    tools: Object.keys(tools).sort(),
    close: async () => {
      for (const c of clients) await c.close();
    },
  };
}
