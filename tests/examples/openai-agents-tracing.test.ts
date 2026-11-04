import { getGlobalTraceProvider, OpenAIProvider, setTraceProcessors, setTracingDisabled, type TracingProcessor } from '@openai/agents';
import OpenAI from 'openai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOpenAIPlanner } from '../../examples/openai-agents/src/agent.js';
import { createPlannerTracing, flushPlannerTracing, installPlannerTraceExporter, redactTraceProcessor } from '../../examples/openai-agents/src/tracing.js';
import type { PlannerGateway } from '../../packages/harness/src/index.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const captured: object[] = [];
const processor: TracingProcessor = {
  onTraceStart: async trace => { const json = trace.toJSON(); if (json) captured.push(json); },
  onTraceEnd: async () => undefined,
  onSpanStart: async () => undefined,
  onSpanEnd: async span => { const json = span.toJSON(); if (json) captured.push(json); },
  shutdown: async () => undefined, forceFlush: async () => undefined,
};
const tools = (): PlannerGateway => ({
  runId: 'managed-run-1', instructions: 'PRIVATE_INSTRUCTIONS use mcp__gate__await_approval',
  tools: [{ canonicalName: 'mcp__gate__await_approval', description: 'Wait', inputSchema: { type: 'object' } }],
  invoke: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'PRIVATE_TOOL_OUTPUT' }] })),
  close: async () => undefined,
});
const data = () => captured.map(item => (item as { span_data?: { type: string; name?: string; data?: Record<string, unknown> } }).span_data).filter(Boolean);
beforeEach(() => { captured.length = 0; setTraceProcessors([redactTraceProcessor(processor)]); setTracingDisabled(false); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setTracingDisabled(true); setTraceProcessors([]); });

it('POSTs a redacted batch through the actual SDK exporter', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  installPlannerTraceExporter('sk-secret');
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
  const gateway = tools();
  gateway.invoke = vi.fn(async () => { throw new Error('PRIVATE_TOOL_ERROR'); });
  const fake = scriptedModel(() => toolCall('mcp__gate__await_approval', { gate_id: 'PRIVATE_PARAMETER' }));
  expect(await createOpenAIPlanner({ gateway, model: fake.model, tracing }).run('PRIVATE_PROMPT')).toMatchObject({ complete: false });
  await getGlobalTraceProvider().forceFlush();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe('https://api.openai.com/v1/traces/ingest');
  expect(JSON.stringify(init.body)).not.toMatch(/PRIVATE_|sk-secret|authorization/);
  expect(String(init.body)).toContain('planner.gate_wait');
});

it('keeps tracing disabled by default even with an ambient SDK trace processor', async () => {
  const fake = scriptedModel(() => answer());
  expect(await createOpenAIPlanner({ gateway: tools(), model: fake.model }).run('PRIVATE_PROMPT')).toMatchObject({ complete: true });
  expect(captured).toEqual([]);
  expect(fake.requests[0]!.tracing).toBe(false);
});

it('records SDK and canonical gate spans with runtime/run correlation and no payloads', async () => {
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
  const fake = scriptedModel((_request, n) => n ? answer('PRIVATE_ANSWER') : toolCall('mcp__gate__await_approval', { gate_id: 'PRIVATE_PARAMETER' }));
  expect(await createOpenAIPlanner({ gateway: tools(), model: fake.model, tracing }).run('PRIVATE_PROMPT')).toMatchObject({ complete: true });
  expect(tracing.id).toMatch(/^trace_[a-zA-Z0-9]{32}$/);
  expect(fake.requests[0]!.tracing).toBe('enabled_without_data');
  expect(captured).toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ node: process.version, model: 'test-model', host: 'openai-agents' }) })]));
  expect(data()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'planner.run', data: expect.objectContaining({ run_id: 'managed-run-1' }) }),
    expect.objectContaining({ name: 'provider.attempt', data: expect.objectContaining({ attempt: 1, input_bytes: expect.any(Number) }) }),
    expect.objectContaining({ name: 'planner.gate_wait', data: expect.objectContaining({ canonical_name: 'mcp__gate__await_approval' }) }),
  ]));
  expect(data()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]));
  expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_|sk-secret|authorization/);
});

it('omits real Responses request/response payloads and preserves SDK request IDs', async () => {
  const client = new OpenAI({ apiKey: 'sk-secret', maxRetries: 0, fetch: async () => new Response(JSON.stringify({ id: 'resp_test123', object: 'response', created_at: 1, status: 'completed', model: 'test-model', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PRIVATE_HTTP_OUTPUT', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json', 'x-request-id': 'req_test123' } }) });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  try {
    const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
    expect(await createOpenAIPlanner({ gateway: tools(), model: await provider.getModel('test-model'), tracing }).run('PRIVATE_PROMPT')).toMatchObject({ complete: true });
    expect(data()).toContainEqual(expect.objectContaining({ type: 'response' }));
    expect(JSON.stringify(captured)).toContain('req_test123');
    expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_|sk-secret|authorization/);
  } finally { await provider.close(); }
});

it('redacts SDK tool exception details with sensitive data capture disabled', async () => {
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
  const gateway = tools();
  gateway.invoke = vi.fn(async () => { throw new Error('PRIVATE_TOOL_ERROR'); });
  const fake = scriptedModel(() => toolCall('mcp__gate__await_approval', { gate_id: 'PRIVATE_PARAMETER' }));
  expect(await createOpenAIPlanner({ gateway, model: fake.model, tracing }).run('PRIVATE_PROMPT')).toMatchObject({ complete: false });
  expect(data()).toContainEqual(expect.objectContaining({ name: 'planner.result', data: expect.objectContaining({ complete: false }) }));
  expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_/);
});

it('records retry/circuit cooldown durations and closes pending spans on cancellation', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const controller = new AbortController();
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
  const fake = scriptedModel(() => { throw new TypeError('Connection error. PRIVATE_ERROR'); });
  const run = createOpenAIPlanner({ gateway: tools(), model: fake.model, tracing, signal: controller.signal }).run('PRIVATE_PROMPT');
  await vi.advanceTimersByTimeAsync(3000);
  controller.abort();
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 3 });
  expect(data()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'provider.backoff' }),
    expect.objectContaining({ name: 'provider.circuit_open' }),
    expect.objectContaining({ name: 'provider.circuit_cooldown' }),
  ]));
  expect(captured.filter(item => 'span_data' in item).every(item => !!(item as { ended_at?: string }).ended_at)).toBe(true);
  expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_/);
});

it('records terminal retry decisions and sanitized error metadata without exception messages', async () => {
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus' });
  const fake = scriptedModel(() => { throw Object.assign(new TypeError('PRIVATE_ERROR https://user:password@example.invalid'), { status: 401, requestID: 'req_test123' }); });
  expect(await createOpenAIPlanner({ gateway: tools(), model: fake.model, tracing }).run('PRIVATE_PROMPT')).toMatchObject({ complete: false, requests: 1 });
  expect(data()).toContainEqual(expect.objectContaining({ name: 'provider.retry_stopped' }));
  expect(JSON.stringify(captured)).toContain('req_test123');
  expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_|password|example\.invalid/);
});

it('never repeats a model/tool callback when a tracing processor throws', async () => {
  setTraceProcessors([{ ...processor, onSpanEnd: async () => { throw new Error('export unavailable'); }, onTraceStart: async () => { throw new Error('export unavailable'); } }]);
  const tracing = createPlannerTracing({ enabled: true, model: 'test-model', deal: 'nimbus', warn: vi.fn() });
  const fake = scriptedModel(() => answer());
  const result = await createOpenAIPlanner({ gateway: tools(), model: fake.model, tracing }).run('PRIVATE_PROMPT');
  expect(result).toMatchObject({ complete: true, requests: 1 });
  expect(fake.requests).toHaveLength(1);
});

it('bounds SDK tracing shutdown at five seconds and absorbs exporter failures', async () => {
  vi.useFakeTimers();
  const shutdown = vi.fn(async (_timeout: number) => new Promise<void>(() => undefined));
  const flush = flushPlannerTracing(shutdown);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await flush).toBe('timeout');
  expect(shutdown).toHaveBeenCalledWith(5000);
  shutdown.mockRejectedValueOnce(new Error('export unavailable'));
  expect(await flushPlannerTracing(shutdown)).toBe('failed');
});

it.each(['SIGINT', 'SIGTERM'])('keeps real SDK %s handling from exiting before delayed cleanup and final-span export', async signal => {
  const script = `
    import { setTracingDisabled } from '@openai/agents';
    import { plannerSignalHandlers } from './examples/openai-agents/src/cli.ts';
    import { createPlannerTracing, installPlannerTraceExporter, flushPlannerTracing } from './examples/openai-agents/src/tracing.ts';
    const batches = [];
    globalThis.fetch = async (_url, init) => { batches.push(String(init.body)); return new Response(null, {status:204}); };
    setTracingDisabled(false);
    installPlannerTraceExporter('fake');
    const controller = new AbortController();
    const remove = plannerSignalHandlers(controller);
    const keepAlive = setInterval(() => {}, 1000);
    const trace = createPlannerTracing({enabled:true, model:'test-model', deal:'nimbus'});
    await trace.scope(async () => {
      await new Promise(resolve => {
        controller.signal.addEventListener('abort', () => setTimeout(() => {
          console.log('HOST_CLEANUP_COMPLETED'); resolve();
        }, 200), {once:true});
        setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 20);
      });
      trace.event('cleanup.completed', {});
    });
    await flushPlannerTracing();
    remove();
    clearInterval(keepAlive);
    console.log(batches.some(body => body.includes('cleanup.completed')) ? 'FINAL_SPAN_EXPORTED' : 'FINAL_SPAN_MISSING');
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('../..', import.meta.url).pathname, timeout: 10_000 });
  expect(result.stdout).toContain('HOST_CLEANUP_COMPLETED');
  expect(result.stdout).toContain('FINAL_SPAN_EXPORTED');
});
