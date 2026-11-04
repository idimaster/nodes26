import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { createPiPlanner } from '../../examples/pi/src/agent.js';
import { modelFromEnv } from '../../examples/pi/src/model.js';
import type { PlannerGateway } from '../../packages/harness/src/types.js';

function fixture() {
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const models = createModels(); models.setProvider(faux.provider);
  const gateway: PlannerGateway = {
    instructions: 'Plan the fictional integration.',
    tools: [{ canonicalName: 'mcp__gate__await_approval', description: 'Wait', inputSchema: { type: 'object', properties: { gate_id: { type: 'string' } }, required: ['gate_id'] } }],
    invoke: vi.fn(async () => ({ isError: true, denied: true, reason: 'wrong deal', structuredContent: { witness: ['gate-1'] }, content: [{ type: 'text' as const, text: 'wrong deal' }] })),
    close: vi.fn(async () => undefined),
  };
  return { faux, gateway, options: { gateway, model: faux.getModel(), streamFn: models.streamSimple.bind(models) } };
}

it('counts provider requests and stops an endless tool loop at exactly three', async () => {
  const f = fixture();
  f.faux.setResponses(Array.from({ length: 8 }, (_, n) => fauxAssistantMessage(fauxToolCall('mcp__gate__await_approval', { gate_id: 'gate-1' }, { id: `call-${n}` }), { stopReason: 'toolUse', timestamp: 1 })));
  const planner = createPiPlanner({ ...f.options, maxSteps: 3 });
  const result = await planner.run('Plan Nimbus');
  expect(result).toMatchObject({ complete: false, requests: 3, error: expect.stringMatching(/budget/) });
  expect(f.faux.state.callCount).toBe(3);
  expect(planner.agent.state.messages.filter(m => m.role === 'toolResult')).toEqual(expect.arrayContaining([
    expect.objectContaining({ isError: true, details: expect.objectContaining({ denied: true, structuredContent: { witness: ['gate-1'] } }) }),
  ]));
});

it('latches infrastructure errors instead of allowing the model to continue', async () => {
  const f = fixture();
  f.gateway.invoke = vi.fn(async () => { throw new Error('graph context unavailable'); });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('mcp__gate__await_approval', { gate_id: 'gate-1' }, { id: 'call-1' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Should never run')]);
  expect(await createPiPlanner(f.options).run('Plan Nimbus')).toMatchObject({ complete: false, requests: 1, error: 'graph context unavailable' });
  expect(f.faux.state.callCount).toBe(1);
});

it('validates the provider, credentials and catalog before MCP startup, preserving the Anthropic URL', () => {
  expect(() => modelFromEnv({ PLANNER_MODEL: 'unknown:test' })).toThrow(/provider/);
  expect(() => modelFromEnv({ PLANNER_MODEL: 'anthropic:missing', ANTHROPIC_API_KEY: 'test' })).toThrow(/model/);
  expect(() => modelFromEnv({ PLANNER_MODEL: 'anthropic:claude-sonnet-4-6' })).toThrow(/ANTHROPIC_API_KEY/);
  expect(modelFromEnv({ PLANNER_MODEL: 'anthropic:claude-sonnet-4-6', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' }).model).toMatchObject({ id: 'claude-sonnet-4-6', baseUrl: 'http://127.0.0.1:9999' });
  expect(modelFromEnv({ ANTHROPIC_API_KEY: 'test' }).model.id).toBe('claude-sonnet-5-5');
  expect(modelFromEnv({ PLANNER_MODEL: 'openai:gpt-5', OPENAI_API_KEY: 'test' }).model.id).toBe('gpt-5');
});
