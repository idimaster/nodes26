import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Model } from '@openai/agents';
import type { launchPlanner } from '../../packages/harness/src/index.js';
import { runCli } from '../../examples/openai-agents/src/cli.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const mocked = vi.hoisted(() => ({ launch: vi.fn(), getModel: vi.fn<() => Promise<Model>>(), close: vi.fn(), inspect: vi.fn() }));
vi.mock('@planner/harness', () => ({ launchPlanner: mocked.launch }));
vi.mock('@openai/agents', async original => ({ ...await original<object>(), OpenAIProvider: class {
  getModel = mocked.getModel;
  close = mocked.close;
} }));

beforeEach(() => {
  vi.stubEnv('PLANNER_MODEL', 'openai:test-model'); vi.stubEnv('OPENAI_API_KEY', 'fake');
  vi.stubEnv('OPENAI_BASE_URL', ''); vi.stubEnv('OPENAI_WEBSOCKET_BASE_URL', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocked.close.mockResolvedValue(undefined);
  mocked.inspect.mockResolvedValue({ deal: 'quarry', gates: [{ id: 'gd-quarry-1-frame-1', status: 'pending' }], state: [] });
  mocked.launch.mockImplementation(async (options: Parameters<typeof launchPlanner>[0]) => options.run({
    instructions: 'Use mcp__gate__await_approval.',
    tools: [{ canonicalName: 'mcp__gate__await_approval', description: 'Wait', inputSchema: { type: 'object' } }],
    invoke: async () => ({ content: [], structuredContent: { status: 'pending', gate_id: 'gd-quarry-1-frame-1' } }),
    close: async () => undefined,
  }, new AbortController().signal, mocked.inspect));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

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
