import OpenAI from 'openai';
import { OpenAIProvider } from '@openai/agents';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOpenAIPlanner } from '../../examples/openai-agents/src/agent.js';
import type { PlannerGateway } from '../../packages/harness/src/index.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const http2 = () => Object.assign(new TypeError('The session has been destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION' });
const network = () => new Error('Connection error.', { cause: http2() });
const httpError = (status: number, headers = new Headers(), code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, headers, code });
const completedHttp = () => new Response(JSON.stringify({ id: 'resp-1', object: 'response', created_at: 1, status: 'completed', model: 'test', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
const gateway = (): PlannerGateway => ({
  instructions: 'Use mcp__gate__await_approval.',
  tools: [{ canonicalName: 'mcp__gate__await_approval', description: 'Wait', inputSchema: { type: 'object' } }],
  invoke: vi.fn(async () => ({ content: [], structuredContent: { gate_id: 'gate-1', status: 'approved' } })),
  close: vi.fn(async () => undefined),
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const badMac = () => new Error('Connection error.', { cause: Object.assign(new Error('TLS record failure'), { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' }) });
it.each([http2, network, badMac])('retries a session or TLS bad-record-MAC failure using the SDK within the same turn', async fail => {
  const fake = scriptedModel((_request, n) => { if (!n) throw fail(); return answer(); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model, maxTurns: 1 }).run('Plan');
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatchObject({ complete: true, requests: 2 });
  expect(fake.requests[1]!.input).toEqual(fake.requests[0]!.input);
});

it('retains completed tool results and does not repeat a tool while retrying the next model request', async () => {
  const tools = gateway();
  const fake = scriptedModel((_request, n) => {
    if (n === 0) return toolCall('mcp__gate__await_approval', { gate_id: 'gate-1' });
    if (n === 1) throw network();
    return answer();
  });
  const run = createOpenAIPlanner({ gateway: tools, model: fake.model, maxTurns: 2 }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: true, requests: 3 });
  expect(tools.invoke).toHaveBeenCalledTimes(1);
  expect(fake.requests[2]!.input).toEqual(fake.requests[1]!.input);
  expect(JSON.stringify(fake.requests[2]!.input)).toContain('gate-1');
});

it.each([429, 503])('honors Retry-After from a real SDK HTTP %i response without nested retries', async status => {
  const calls = vi.fn(async () => calls.mock.calls.length === 1
    ? new Response(JSON.stringify({ error: { message: 'temporarily busy', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '2' } })
    : completedHttp());
  const provider = new OpenAIProvider({ openAIClient: new OpenAI({ apiKey: 'fake', maxRetries: 0, fetch: calls }), useResponses: true });
  try {
    const run = createOpenAIPlanner({ gateway: gateway(), model: await provider.getModel('test'), maxTurns: 1 }).run('Plan');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toMatchObject({ complete: true, requests: 2 });
    expect(calls).toHaveBeenCalledTimes(2);
  } finally { await provider.close(); }
});

it('retries an HTTP/2 failure while reading the HTTP response body through the real SDK', async () => {
  const fetch = vi.fn(async () => fetch.mock.calls.length === 1
    ? new Response(new ReadableStream({ start(controller) { controller.error(http2()); } }), { headers: { 'content-type': 'application/json' } })
    : completedHttp());
  const provider = new OpenAIProvider({ openAIClient: new OpenAI({ apiKey: 'fake', maxRetries: 0, fetch }), useResponses: true });
  try {
    const run = createOpenAIPlanner({ gateway: gateway(), model: await provider.getModel('test') }).run('Plan');
    await vi.runAllTimersAsync();
    expect(await run).toMatchObject({ complete: true, requests: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { await provider.close(); }
});

it.each([
  ['retry-after-ms', '2500', 2500],
  ['retry-after', 'Thu, 01 Jan 2026 00:00:03 GMT', 3000],
] as const)('uses the SDK parser for %s', async (header, value, delay) => {
  const fake = scriptedModel((_request, n) => { if (!n) throw httpError(429, new Headers({ [header]: value })); return answer(); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model }).run('Plan');
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatchObject({ complete: true, requests: 2 });
});

it('opens a 30-second circuit after three failures, allows one probe and closes on success', async () => {
  const events: unknown[] = [];
  const fake = scriptedModel((_request, n) => { if (n < 3) throw network(); return answer(); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model, onProviderEvent: event => events.push(event) }).run('Plan');
  await vi.advanceTimersByTimeAsync(3000);
  expect(fake.requests).toHaveLength(3);
  expect(events).toContainEqual(expect.objectContaining({ type: 'circuit_open', delayMs: 30_000 }));
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fake.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatchObject({ complete: true, requests: 4 });
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'circuit_probe' }), expect.objectContaining({ type: 'circuit_closed' })]));
});

it('stops after a failed circuit probe, with exactly four model attempts', async () => {
  const events: unknown[] = [];
  const fake = scriptedModel(() => { throw network(); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model, onProviderEvent: event => events.push(event) }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 4, text: '', error: expect.stringContaining('circuit probe failed') });
  expect(events).toContainEqual(expect.objectContaining({ type: 'circuit_failed' }));
  expect(fake.requests).toHaveLength(4);
});

it('keeps the circuit open for a longer permitted Retry-After and resets failures after recovery', async () => {
  const events: unknown[] = [];
  const fake = scriptedModel((_request, n) => {
    if (n < 2 || n === 4) throw network();
    if (n === 2) throw httpError(429, new Headers({ 'retry-after': '60' }));
    if (n === 3) return toolCall('mcp__gate__await_approval', { gate_id: 'gate-1' });
    return answer();
  });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model, maxTurns: 2, onProviderEvent: event => events.push(event) }).run('Plan');
  await vi.advanceTimersByTimeAsync(62_999);
  expect(fake.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.requests).toHaveLength(5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await run).toMatchObject({ complete: true, requests: 6 });
  expect(events.filter(event => (event as { type: string }).type === 'circuit_open')).toHaveLength(1);
});

it.each([0, 3000])('cancels SDK backoff/cooldown at %i ms without another provider attempt', async elapsed => {
  const controller = new AbortController();
  const fake = scriptedModel(() => { throw network(); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model, signal: controller.signal }).run('Plan');
  await vi.advanceTimersByTimeAsync(elapsed);
  const attempts = fake.requests.length;
  controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await run).toMatchObject({ complete: false, requests: attempts, text: '' });
  expect(fake.requests).toHaveLength(attempts);
});

it.each([
  httpError(400), httpError(401), httpError(403), httpError(404), httpError(422),
  httpError(429, new Headers(), 'insufficient_quota'),
  httpError(429, new Headers(), 'billing_hard_limit_reached'),
  httpError(503, new Headers({ 'x-should-retry': 'false' })),
  new Error('Connection error.', { cause: Object.assign(new Error('TLS failure'), { code: 'CERT_HAS_EXPIRED' }) }),
  new TypeError('application bug'),
])('does not retry terminal request/quota/TLS failures: %s', async error => {
  const fake = scriptedModel(() => { throw error; });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 1 });
});

it.each([
  { suggested: false }, { suggested: true, replaySafety: 'unsafe' as const }, { suggested: true, responseStarted: true },
])('forwards and respects provider retry advice: %j', async advice => {
  const error = network();
  const fake = scriptedModel(() => { throw error; });
  fake.model.getRetryAdvice = vi.fn(() => advice);
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 1 });
  expect(fake.model.getRetryAdvice).toHaveBeenCalledWith(expect.objectContaining({ error }));
});

it('declines excessive server delay instead of retrying before Retry-After', async () => {
  const fake = scriptedModel(() => { throw httpError(429, new Headers({ 'retry-after': '61' })); });
  const run = createOpenAIPlanner({ gateway: gateway(), model: fake.model }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 1, error: expect.stringMatching(/retry delay.*60000/) });
});

it('never applies model retries to an uncertain MCP failure', async () => {
  const tools = gateway();
  tools.invoke = vi.fn(async () => { throw network(); });
  const fake = scriptedModel(() => toolCall('mcp__gate__await_approval', { gate_id: 'gate-1' }));
  const run = createOpenAIPlanner({ gateway: tools, model: fake.model }).run('Plan');
  await vi.runAllTimersAsync();
  expect(await run).toMatchObject({ complete: false, requests: 1 });
  expect(tools.invoke).toHaveBeenCalledTimes(1);
});
