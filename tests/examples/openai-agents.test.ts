import OpenAI from 'openai';
import { OpenAIProvider } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { createOpenAIPlanner } from '../../examples/openai-agents/src/agent.js';
import { modelFromEnv } from '../../examples/openai-agents/src/model.js';
import { mapPlannerTools } from '../../examples/openai-agents/src/tools.js';
import { plannerDefinition, type PlannerGateway } from '../../packages/harness/src/index.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const canonical = 'mcp__neo4j-write__write-cypher';
const mapped = 'mcp__neo4j_write__write_cypher';
const schema = { type: 'object' as const, properties: { query: { type: 'string' }, params: { type: 'object', additionalProperties: true } }, required: ['query'], additionalProperties: false };
const input = { query: 'RETURN $nested AS value', params: { deal: 'nimbus', nested: [{ values: [1, null, { enabled: true }] }] } };
function fixture(): { -readonly [K in keyof PlannerGateway]: PlannerGateway[K] } {
  return {
    instructions: `Use \`${canonical}\` and preserve its parameters.`,
    tools: [{ canonicalName: canonical, description: 'Write', inputSchema: schema }],
    invoke: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'denied' }], structuredContent: { witness: ['gate-1'] }, isError: true, denied: true, reason: 'missing gate' })),
    close: vi.fn(async () => undefined),
  };
}

it('maps all 15 names and prompt references bijectively without repeating the skill', () => {
  const definition = plannerDefinition(new URL('../..', import.meta.url).pathname);
  const gateway = fixture();
  gateway.instructions = definition.instructions;
  gateway.tools = definition.tools.map(canonicalName => ({ canonicalName, description: 'tool', inputSchema: schema }));
  const mapping = mapPlannerTools(gateway);
  expect(mapping.tools).toHaveLength(15);
  expect(new Set(mapping.canonicalToProvider.values()).size).toBe(15);
  for (const [name, provider] of mapping.canonicalToProvider) {
    expect(mapping.providerToCanonical.get(provider)).toBe(name);
    expect(mapping.tools.find(t => t.name === provider)?.name).toBe(provider);
  }
  expect(mapping.instructions).not.toMatch(/mcp__[^\s`]*-/);
  expect(mapping.instructions.split('Ask through a gate, never only in chat')).toHaveLength(2);
});

it('rejects normalized collisions, oversized names and undeclared full prompt tokens', () => {
  const gateway = fixture();
  gateway.tools = [...gateway.tools, { ...gateway.tools[0]!, canonicalName: mapped }];
  expect(() => mapPlannerTools(gateway)).toThrow(/collision/);
  gateway.tools = [{ ...gateway.tools[0]!, canonicalName: `mcp__gate__${'a'.repeat(64)}` }];
  expect(() => mapPlannerTools(gateway)).toThrow(/64/);
  gateway.tools = fixture().tools;
  gateway.instructions += ' Unknown mcp__gate__missing.';
  expect(() => mapPlannerTools(gateway)).toThrow(/undeclared/);
  gateway.instructions = `${canonical}_suffix`;
  expect(() => mapPlannerTools(gateway)).toThrow(/undeclared/);
});

it('preserves nested params and structured policy witnesses across an SDK tool round trip', async () => {
  const gateway = fixture();
  const events: unknown[] = [];
  const fake = scriptedModel((_request, n) => n === 0 ? toolCall(mapped, input) : answer());
  const planner = createOpenAIPlanner({ gateway, model: fake.model, onEvent: event => events.push(event) });
  expect(await planner.run('Plan Nimbus')).toMatchObject({ complete: true, requests: 2, text: 'Done' });
  expect(gateway.invoke).toHaveBeenCalledWith(canonical, input, expect.any(AbortSignal));
  expect(fake.requests[0]).toMatchObject({ systemInstructions: `Use \`${mapped}\` and preserve its parameters.`, modelSettings: { parallelToolCalls: false }, tracing: false });
  expect(fake.requests[0]!.tools).toEqual([expect.objectContaining({ name: mapped, strict: false, parameters: schema })]);
  expect(JSON.stringify(fake.requests[1]!.input)).toContain('missing gate');
  expect(JSON.stringify(fake.requests[1]!.input)).toContain('witness');
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_start', canonicalName: canonical }), expect.objectContaining({ type: 'tool_end', canonicalName: canonical })]));
  expect(planner.agent.mcpServers).toEqual([]);
  expect(planner.agent.handoffs).toEqual([]);
  await expect(planner.run('again')).rejects.toThrow(/one prompt/);
});

it('serializes the real Responses HTTP request with unchanged non-strict schemas and mapped names', async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new OpenAI({ apiKey: 'fake', maxRetries: 0, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const output = bodies.length === 1
      ? [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: mapped, arguments: JSON.stringify(input), status: 'completed' }]
      : [{ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }];
    return new Response(JSON.stringify({ id: `resp-${bodies.length}`, object: 'response', created_at: 1, status: 'completed', model: 'test-model', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  const gateway = fixture();
  try {
    const model = await provider.getModel('test-model');
    expect(await createOpenAIPlanner({ gateway, model }).run('Plan')).toMatchObject({ complete: true });
    expect(bodies[0]).toMatchObject({ model: 'test-model', parallel_tool_calls: false, tools: [{ type: 'function', name: mapped, strict: false, parameters: schema }] });
    expect(JSON.stringify(bodies[0])).toContain(mapped);
    expect(JSON.stringify(bodies[0])).not.toContain(canonical);
    expect(bodies[1]).not.toHaveProperty('previous_response_id');
    expect(gateway.invoke).toHaveBeenCalledWith(canonical, input, expect.any(AbortSignal));
  } finally { await provider.close(); }
});

it('bounds an endless SDK loop at three turns and suppresses partial completion text', async () => {
  const gateway = fixture();
  const fake = scriptedModel((_request, n) => toolCall(mapped, input, `call-${n}`));
  expect(await createOpenAIPlanner({ gateway, model: fake.model, maxTurns: 3 }).run('Plan')).toMatchObject({ complete: false, requests: 3, text: '', error: expect.stringMatching(/incomplete.*3|3.*incomplete/) });
  expect(fake.requests).toHaveLength(3);
});

it('stops on executor infrastructure failure without another model call', async () => {
  const gateway = fixture();
  gateway.invoke = vi.fn(async () => { throw new Error('graph context unavailable'); });
  const fake = scriptedModel(() => toolCall(mapped, input));
  expect(await createOpenAIPlanner({ gateway, model: fake.model }).run('Plan')).toMatchObject({ complete: false, requests: 1, text: '', error: expect.stringContaining('graph context unavailable') });
  expect(gateway.invoke).toHaveBeenCalledTimes(1);
});

it('does not call the model or gateway after cancellation', async () => {
  const gateway = fixture();
  const controller = new AbortController(); controller.abort();
  const fake = scriptedModel(() => answer());
  expect(await createOpenAIPlanner({ gateway, model: fake.model, signal: controller.signal }).run('Plan')).toMatchObject({ complete: false, requests: 0, text: '' });
  expect(fake.requests).toHaveLength(0);
  expect(gateway.invoke).not.toHaveBeenCalled();
});

it('forwards cancellation to an active SDK model request and returns incomplete', async () => {
  const controller = new AbortController();
  const fake = scriptedModel(request => new Promise((_resolve, reject) => {
    expect(request.signal).toBeDefined();
    request.signal!.addEventListener('abort', () => reject(new Error('model request aborted')), { once: true });
    controller.abort();
  }));
  const gateway = fixture();
  expect(await createOpenAIPlanner({ gateway, model: fake.model, signal: controller.signal }).run('Plan')).toMatchObject({ complete: false, requests: 1, text: '' });
  expect(gateway.invoke).not.toHaveBeenCalled();
});

it('returns incomplete on a provider failure and validates its turn cap', async () => {
  const gateway = fixture();
  const fake = scriptedModel(() => { throw new Error('provider failed'); });
  expect(await createOpenAIPlanner({ gateway, model: fake.model }).run('Plan')).toMatchObject({ complete: false, requests: 1, text: '', error: expect.stringContaining('provider failed') });
  for (const maxTurns of [0, -1, 1.5, NaN]) expect(() => createOpenAIPlanner({ gateway, model: fake.model, maxTurns })).toThrow(/positive integer/);
});

it('validates explicit OpenAI credentials and model before launching children', () => {
  expect(() => modelFromEnv({ OPENAI_API_KEY: 'fake' })).toThrow(/PLANNER_MODEL/);
  expect(() => modelFromEnv({ PLANNER_MODEL: 'openai-compatible:test', OPENAI_API_KEY: 'fake' })).toThrow(/PLANNER_MODEL/);
  expect(() => modelFromEnv({ PLANNER_MODEL: 'openai:test' })).toThrow(/OPENAI_API_KEY/);
  expect(() => modelFromEnv({ PLANNER_MODEL: 'openai:test', OPENAI_API_KEY: ' ', OPENAI_BASE_URL: 'http://localhost' })).toThrow();
  expect(() => modelFromEnv({ PLANNER_MODEL: 'openai:test', OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: 'http://localhost' })).toThrow(/custom/);
  expect(modelFromEnv({ PLANNER_MODEL: 'openai:test', OPENAI_API_KEY: 'fake' })).toEqual({ modelId: 'test', apiKey: 'fake' });
});
