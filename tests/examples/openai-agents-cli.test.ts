import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Model } from '@openai/agents';
import type { launchPlanner } from '../../packages/harness/src/index.js';
import { runCli } from '../../examples/openai-agents/src/cli.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const mocked = vi.hoisted(() => ({ launch: vi.fn(), getModel: vi.fn<() => Promise<Model>>(), close: vi.fn(), inspect: vi.fn(), flush: vi.fn(), installExporter: vi.fn(), providerOptions: [] as unknown[] }));
vi.mock('@planner/harness', () => ({ launchPlanner: mocked.launch }));
vi.mock('../../examples/openai-agents/src/tracing.js', async original => ({ ...await original<object>(), flushPlannerTracing: mocked.flush, installPlannerTraceExporter: mocked.installExporter }));
vi.mock('@openai/agents', async original => ({ ...await original<object>(), OpenAIProvider: class {
  constructor(options: unknown) { mocked.providerOptions.push(options); }
  getModel = mocked.getModel;
  close = mocked.close;
} }));

beforeEach(() => {
  vi.stubEnv('PLANNER_MODEL', 'openai:test-model'); vi.stubEnv('OPENAI_API_KEY', 'fake');
  vi.stubEnv('OPENAI_BASE_URL', ''); vi.stubEnv('OPENAI_WEBSOCKET_BASE_URL', '');
  vi.stubEnv('OPENAI_AGENTS_DISABLE_TRACING', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocked.close.mockResolvedValue(undefined);
  mocked.flush.mockResolvedValue('flushed');
  mocked.inspect.mockResolvedValue({ deal: 'quarry', gates: [{ id: 'gd-quarry-1-frame-1', status: 'pending' }], state: [] });
  mocked.launch.mockImplementation(async (options: Parameters<typeof launchPlanner>[0]) => options.run({
    runId: 'managed-run-1', instructions: 'Use mcp__gate__await_approval.',
    tools: [{ canonicalName: 'mcp__gate__await_approval', description: 'Wait', inputSchema: { type: 'object' } }],
    invoke: async () => ({ content: [], structuredContent: { status: 'pending', gate_id: 'gd-quarry-1-frame-1' } }),
    close: async () => undefined,
  }, options.signal ?? new AbortController().signal, mocked.inspect));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); mocked.providerOptions.length = 0; });

it('disables nested HTTP retries so the Runner owns the physical attempt budget', async () => {
  mocked.getModel.mockResolvedValue(scriptedModel(() => answer()).model);
  await runCli(['--deal', 'quarry']);
  expect(mocked.providerOptions).toEqual([expect.objectContaining({ openAIClient: expect.objectContaining({ maxRetries: 0, baseURL: 'https://api.openai.com/v1' }), useResponses: true })]);
  expect(mocked.flush).not.toHaveBeenCalled();
  expect(mocked.installExporter).not.toHaveBeenCalled();
});

it('prints trace/runtime/run correlation and flushes only when --trace is requested', async () => {
  mocked.getModel.mockResolvedValue(scriptedModel(() => answer()).model);
  await runCli(['--deal', 'quarry', '--trace']);
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/trace: trace_.*dashboard: https:\/\/platform.openai.com\/traces.*Node/));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('guard run: managed-run-1'));
  expect(mocked.flush).toHaveBeenCalledTimes(1);
  expect(mocked.installExporter).toHaveBeenCalledExactlyOnceWith('fake');
});

it('still closes the provider and flushes tracing after model construction fails', async () => {
  mocked.getModel.mockRejectedValue(new Error('construction failed'));
  await expect(runCli(['--trace'])).rejects.toThrow('construction failed');
  expect(mocked.close).toHaveBeenCalledTimes(1);
  expect(mocked.flush).toHaveBeenCalledTimes(1);
});

it('preserves successful planner completion when trace export times out', async () => {
  mocked.getModel.mockResolvedValue(scriptedModel(() => answer()).model);
  mocked.flush.mockResolvedValue('timeout');
  await expect(runCli(['--trace'])).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('trace export timeout'));
});

it('flushes tracing after the CLI SIGINT handler cancels model work', async () => {
  const on = vi.spyOn(process, 'on');
  mocked.getModel.mockResolvedValue(scriptedModel(request => {
    const abort = on.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
    if (!abort) throw new Error('missing SIGINT handler');
    abort();
    request.signal?.throwIfAborted();
    return answer();
  }).model);
  await expect(runCli(['--trace'])).rejects.toThrow();
  expect(mocked.close).toHaveBeenCalledTimes(1);
  expect(mocked.flush).toHaveBeenCalledTimes(1);
});

it('rejects conflicting tracing configuration before managed launch', async () => {
  vi.stubEnv('OPENAI_AGENTS_DISABLE_TRACING', '1');
  await expect(runCli(['--trace'])).rejects.toThrow(/conflicts/);
  expect(mocked.launch).not.toHaveBeenCalled();
});

it('rejects CLI completion at the turn cap, prints selected-deal graph state and closes the provider', async () => {
  const fake = scriptedModel((_request, n) => toolCall('mcp__gate__await_approval', { gate_id: 'gd-quarry-1-frame-1' }, `call-${n}`));
  mocked.getModel.mockResolvedValue(fake.model);
  await expect(runCli(['--deal', 'quarry', '--max-turns', '3'])).rejects.toThrow(/incomplete.*3/);
  expect(fake.requests).toHaveLength(3);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('gd-quarry-1-frame-1'));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('inspect --deal quarry'));
  expect(mocked.close).toHaveBeenCalledTimes(1);
});

it('closes the provider if model construction fails', async () => {
  mocked.getModel.mockRejectedValue(new Error('construction failed'));
  await expect(runCli(['--deal', 'quarry'])).rejects.toThrow('construction failed');
  expect(mocked.close).toHaveBeenCalledTimes(1);
});

it('fails when graph inspection is unavailable instead of printing an unverified completion narrative', async () => {
  mocked.getModel.mockResolvedValue(scriptedModel(() => answer('A purported committed plan')).model);
  mocked.inspect.mockRejectedValue(new Error('graph unavailable'));
  await expect(runCli(['--deal', 'quarry'])).rejects.toThrow(/graph state unavailable.*inspect --deal quarry/);
  expect(console.log).not.toHaveBeenCalledWith('A purported committed plan');
  expect(mocked.close).toHaveBeenCalledTimes(1);
});

it('rejects invalid configuration before managed launch', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  await expect(runCli([])).rejects.toThrow(/OPENAI_API_KEY/);
  expect(mocked.launch).not.toHaveBeenCalled();
});
