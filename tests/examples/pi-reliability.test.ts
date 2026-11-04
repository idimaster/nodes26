import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, normalizeContext, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import { createReliableStream, type ProviderStatus } from '../../examples/pi/src/reliability.js';
import { createPiPlanner } from '../../examples/pi/src/agent.js';
import { modelFromEnv } from '../../examples/pi/src/model.js';
import type { PlannerGateway } from '../../packages/harness/src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapture, readCapture } from '../../packages/diagnostics/src/index.js';

const context = normalizeContext({ messages: [{ role: 'user', content: 'Plan Nimbus.', timestamp: 1 }] });
const fakeModel = fauxProvider().getModel();
const failed = (message: string, content: AssistantMessage['content'] = []) => fauxAssistantMessage(content, { stopReason: 'error', errorMessage: message, timestamp: 1 });
function stream(message: AssistantMessage) {
  if (message.stopReason === 'pending') throw new Error('test fixture requires a terminal message');
  const s = createAssistantMessageEventStream();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') s.push({ type: 'error', reason: message.stopReason, error: message });
  else s.push({ type: 'done', reason: message.stopReason, message });
  s.end(message); return s;
}
const completeResponse = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response-test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const httpError = (status: number, code = 'rate_limit_exceeded', headers: Record<string, string> = { 'retry-after-ms': '1' }) => new Response(JSON.stringify({ error: { code, type: code, message: code } }), { status, headers: { 'content-type': 'application/json', ...headers } });
function native(fetch: typeof globalThis.fetch, maxRequests = 200) {
  const provider = modelFromEnv({ PLANNER_MODEL: 'openai:gpt-5', OPENAI_API_KEY: 'test-key' });
  const events: ProviderStatus[] = [];
  const reliable = createReliableStream({ streamFn: provider.streamFn, maxRequests, fetch, onStatus: e => { events.push(e); } });
  return { reliable, events, model: provider.model };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('correlates each actual HTTP fetch without recording its body', async () => {
  const capture = createCapture({ root: mkdtempSync(join(tmpdir(), 'planner-http-')), deal: 'nimbus' })!;
  const provider = modelFromEnv({ PLANNER_MODEL: 'openai:gpt-5', OPENAI_API_KEY: 'test-key' });
  const seen: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
    seen.push(new Headers(init?.headers).get('X-Client-Request-Id') ?? '');
    return completeResponse();
  });
  const reliable = createReliableStream({ streamFn: provider.streamFn, maxRequests: 2, fetch, capture });
  const result = await reliable.streamFn(provider.model, context);
  expect((await result.result()).stopReason).toBe('stop');
  capture.finish({ outcome: 'completed', providerAttempts: reliable.requests, httpAttempts: reliable.httpAttempts });
  const records = (await readCapture(capture.path)).records;
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(records.find(r => r.event === 'provider.http.started')?.data.client_request_id).toBe(seen[0]);
  expect(records.find(r => r.event === 'provider.http.received')?.data.status).toBe(200);
  expect(JSON.stringify(records)).not.toContain('test-key');
});

it('uses native SDK HTTP retry with Retry-After and counts every network attempt', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(httpError(429, 'rate_limit_exceeded', { 'retry-after-ms': '2500' })).mockImplementationOnce(async () => completeResponse());
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(2400);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(200);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(2); expect(reliable.requests).toBe(2);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'retry', kind: 'transport', attempt: 2 })]));
});

it.each([[400, 'invalid_request'], [401, 'invalid_api_key'], [403, 'permission_denied'], [429, 'insufficient_quota']])('does not retry permanent HTTP %s (%s)', async (status, code) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(status, code));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  expect((await response.result()).stopReason).toBe('error');
  expect(fetch).toHaveBeenCalledTimes(1); expect(reliable.requests).toBe(1);
});

it('opens after three failures, waits thirty seconds, probes once and closes on success', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => fetch.mock.calls.length <= 3 ? httpError(503, 'server_busy') : completeResponse());
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'circuit_open', delayMs: 30_000 })));
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1100);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(4); expect(reliable.requests).toBe(4);
  expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['circuit_probe', 'circuit_closed']));
});

it('stops after a failed circuit probe without multiplying SDK and assistant retries', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(503, 'server_busy'));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await vi.advanceTimersByTimeAsync(35_000);
  expect(await response.result()).toMatchObject({ stopReason: 'error', errorMessage: expect.stringMatching(/circuit.*probe/i) });
  expect(fetch).toHaveBeenCalledTimes(4); expect(reliable.requests).toBe(4);
});

it.each([408, 409])('preserves transient HTTP %s classification across the assistant retry boundary', async status => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => fetch.mock.calls.length <= 3 ? httpError(status, 'request_conflict') : completeResponse());
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(events.some(e => e.type === 'circuit_open')).toBe(true));
  await vi.advanceTimersByTimeAsync(30_100);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('counts connection failures while reading HTTP error bodies before the circuit probe', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    if (fetch.mock.calls.length > 3) return completeResponse();
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Connection error.')); } }), { status: 503, headers: { 'retry-after-ms': '1' } });
  });
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(1600);
  await vi.waitFor(() => expect(events.some(e => e.type === 'circuit_open')).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1100);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('honors Retry-After even if the HTTP error body cannot be read', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => fetch.mock.calls.length === 1
    ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('Connection error.')); } }), { status: 503, headers: { 'retry-after': '45' } })
    : completeResponse());
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(44_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1100);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('refuses an excessive server delay even if its error body is broken', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
    new ReadableStream({ start(controller) { controller.error(new Error('Connection error.')); } }), { status: 503, headers: { 'retry-after': '120' } },
  ));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  expect(await response.result()).toMatchObject({ stopReason: 'error', errorMessage: expect.stringMatching(/retry delay/i) });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not turn a long Retry-After into a shorter assistant-level retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(429, 'rate_limit_exceeded', { 'retry-after': '120' }));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  expect(await response.result()).toMatchObject({ stopReason: 'error', errorMessage: expect.stringMatching(/retry delay/i) });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancellation interrupts SDK backoff without another network request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(429, 'rate_limit_exceeded', { 'retry-after': '30' }));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context, { signal: controller.signal });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  controller.abort();
  expect((await response.result()).stopReason).toBe('aborted');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancellation interrupts an open circuit without allowing its probe', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(503, 'server_busy'));
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context, { signal: controller.signal });
  await vi.waitFor(() => expect(events.some(e => e.type === 'circuit_open')).toBe(true));
  await vi.advanceTimersByTimeAsync(1500);
  controller.abort();
  expect((await response.result()).stopReason).toBe('aborted');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('retains the final HTTP Retry-After when crossing into a circuit probe', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const attempt = fetch.mock.calls.length;
    return attempt < 4 ? httpError(429, 'rate_limit_exceeded', { 'retry-after-ms': attempt === 3 ? '45000' : '1' }) : completeResponse();
  });
  const { reliable, model, events } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(events.some(e => e.type === 'circuit_open')).toBe(true));
  await vi.advanceTimersByTimeAsync(44_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1100);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('does not retry when the provider explicitly refuses retries', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => httpError(503, 'server_busy', { 'x-should-retry': 'false' }));
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  expect((await response.result()).stopReason).toBe('error');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('uses SDK jittered exponential backoff to recover from a connection failure', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async () => completeResponse());
  const { reliable, model } = native(fetch);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(400);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(200);
  expect((await response.result()).stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('applies the run budget to native retries', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));
  const { reliable, model } = native(fetch, 2);
  const response = await reliable.streamFn(model, context);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await response.result()).toMatchObject({ stopReason: 'error', errorMessage: expect.stringMatching(/budget/) });
  expect(fetch).toHaveBeenCalledTimes(2); expect(reliable.requests).toBe(2);
});

it('retries an interrupted assistant stream without replaying completed or partial tool calls', async () => {
  vi.useFakeTimers();
  const gateway: PlannerGateway = {
    instructions: 'Plan Nimbus.', tools: [{ canonicalName: 'mcp__neo4j-write__write-cypher', description: 'Write', inputSchema: { type: 'object' } }],
    invoke: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'written' }] })), close: async () => undefined,
  };
  const completedCall = fauxToolCall('mcp__neo4j-write__write-cypher', {}, { id: 'completed' });
  const partialCall = fauxToolCall('mcp__neo4j-write__write-cypher', {}, { id: 'partial' });
  const messages = [fauxAssistantMessage(completedCall, { stopReason: 'toolUse', timestamp: 1 }), failed('Connection error.', [partialCall]), fauxAssistantMessage('Done.', { timestamp: 1 })];
  const contexts: TranscriptContext[] = [];
  const streamFn: StreamFn = vi.fn(async (_model, current) => { contexts.push(structuredClone(current)); return stream(messages.shift()!); });
  const planner = createPiPlanner({ gateway, model: fakeModel, streamFn });
  const result = planner.run('Plan Nimbus.');
  await vi.waitFor(() => expect(streamFn).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ complete: true, requests: 3, text: 'Done.' });
  expect(gateway.invoke).toHaveBeenCalledTimes(1);
  expect(contexts[2]!.messages.filter(m => m.role === 'toolResult')).toHaveLength(1);
  expect(planner.agent.state.messages.filter(m => m.role === 'assistant' && m.stopReason === 'error')).toHaveLength(0);
});

it('strips failed partial calls when no attempt budget remains', async () => {
  const partial = fauxToolCall('mcp__neo4j-write__write-cypher', {}, { id: 'partial' });
  const reliable = createReliableStream({ streamFn: async () => stream(failed('Connection error.', [partial])), maxRequests: 1 });
  vi.useFakeTimers();
  const response = await reliable.streamFn(fakeModel, context);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await response.result()).toMatchObject({ stopReason: 'error', content: [] });
  expect(reliable.requests).toBe(1);
});
