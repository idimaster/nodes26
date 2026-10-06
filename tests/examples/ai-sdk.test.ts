import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlanner, guardWrites, modelFromEnv, plannerDefinition } from '../../examples/ai-sdk/src/agent.js';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T5.3, without an LLM: the AI SDK host keeps the same allowlist, guard, and step cap as Claude Code. */

const ROOT = new URL('../..', import.meta.url).pathname;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolCall = (toolName: string, input: unknown): LanguageModelV4GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: `c-${toolName}-${Math.random()}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage,
  warnings: [],
});
const text = (t: string): LanguageModelV4GenerateResult => ({ content: [{ type: 'text', text: t }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] });
const findings = async () => Number((await driver.executeQuery("MATCH (f:Finding {deal_code: 'nimbus'}) RETURN count(f) AS n")).records[0]?.get('n'));

let driver: Driver;
beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
});
afterAll(async () => {
  await driver.close();
});

describe('examples/ai-sdk', () => {
  it('picks the model from PLANNER_MODEL, and refuses an unknown provider', () => {
    expect(modelFromEnv({ PLANNER_MODEL: 'anthropic:claude-sonnet-5-5', ANTHROPIC_API_KEY: 'x' })).toMatchObject({ modelId: 'claude-sonnet-5-5' });
    expect(modelFromEnv({ PLANNER_MODEL: 'openai-compatible:some-model', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:9/v1' })).toMatchObject({ modelId: 'some-model' });
    expect(() => modelFromEnv({ PLANNER_MODEL: 'other:x' })).toThrow(/unknown provider/);
  });

  it('the write guard runs before write-cypher; a denial never reaches the server', async () => {
    const seen: unknown[] = [];
    const tools = guardWrites({ 'mcp__neo4j-write__write-cypher': { inputSchema: {} as never, execute: async (input: unknown) => (seen.push(input), [{ ok: 1 }]) } as never }, driver);
    const run = (query: string, params: Record<string, unknown>) =>
      (tools['mcp__neo4j-write__write-cypher']?.execute as (i: unknown, o: unknown) => Promise<unknown>)({ query, params }, { toolCallId: 't', messages: [] });
    expect(await run('MATCH (n) DETACH DELETE n RETURN 1', {})).toMatchObject({ denied: true, reason: expect.stringMatching(/G2/) });
    expect(seen).toEqual([]);
    const ok = "MERGE (i:Iteration {deal_code: $deal, n: $n}) ON CREATE SET i.started_at = datetime(), i.status = 'draft' RETURN i.n AS n";
    expect(await run(ok, { deal: 'nimbus', n: 1 })).toEqual([{ ok: 1 }]);
    expect(seen).toHaveLength(1);
  });

  it('over the real MCP servers: the allowlist matches the Claude Code agent, and a destructive write is denied', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall('mcp__neo4j-write__write-cypher', { query: "MATCH (f:Finding {deal_code: $deal}) DETACH DELETE f RETURN count(*) AS n", params: { deal: 'nimbus' } }), text('Done.')],
    });
    const before = await findings();
    const planner = await createPlanner({ root: ROOT, driver, model, env: { GATE_HTTP: 'off' } });
    try {
      expect(planner.tools).toEqual([...plannerDefinition(ROOT).tools].sort());
      const result = await planner.agent.generate({ prompt: 'Plan the Nimbus integration.' });
      const output = result.steps[0]?.toolResults[0]?.output as { denied?: boolean; reason?: string };
      expect(output).toMatchObject({ denied: true, reason: expect.stringMatching(/G2/) });
      expect(result.text).toBe('Done.');
      expect(await findings()).toBe(before);
    } finally {
      await planner.close();
    }
  }, 60_000);

  it('stops at the step cap', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => toolCall('mcp__neo4j-read__read-cypher', { query: 'RETURN 1 AS ok' }) });
    const planner = await createPlanner({ root: ROOT, driver, model, maxSteps: 3, env: { GATE_HTTP: 'off' } });
    try {
      expect((await planner.agent.generate({ prompt: 'loop' })).steps).toHaveLength(3);
    } finally {
      await planner.close();
    }
  }, 60_000);
});
