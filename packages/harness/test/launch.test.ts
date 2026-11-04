import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ fork: vi.fn(), gateway: vi.fn(), driver: vi.fn(), fresh: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: mocked.fork }));
vi.mock('../src/gateway.js', async original => ({ ...await original<object>(), createGateway: mocked.gateway }));
vi.mock('../../../graph/connection.js', async original => ({ ...await original<object>(), openDriver: mocked.driver }));
vi.mock('../src/recovery.js', () => ({ assertFreshRun: mocked.fresh }));
vi.mock('../../../scripts/build-ui.js', () => ({ buildUiIfStale: async () => false }));
import { launchPlanner } from '../src/launch.js';

const originalRoot = new URL('../../..', import.meta.url).pathname;
const dirs: string[] = [];
function fixture(mode: 'ready' | 'bad-token' | 'silent' = 'ready') {
  const root = mkdtempSync(join(tmpdir(), 'planner-launch-')); dirs.push(root);
  mkdirSync(join(root, 'plugin/agents'), { recursive: true });
  writeFileSync(join(root, 'plugin/agents/planner.md'), readFileSync(join(originalRoot, 'plugin/agents/planner.md')));
  writeFileSync(join(root, '.mcp.json'), readFileSync(join(originalRoot, '.mcp.json')));
  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null as number | null, signalCode: null as string | null, stderr: new PassThrough(), kill: vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; }) });
  mocked.fork.mockImplementation((_path, _args, options: { env: Record<string, string> }) => {
    if (mode !== 'silent') queueMicrotask(() => child.emit('message', { type: 'ready', token: mode === 'bad-token' ? 'incorrect' : options.env.PLANNER_MANAGED_TOKEN, address: '127.0.0.1', port: 4646 }));
    return child;
  });
  const driver = { verifyConnectivity: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const gateway = { close: vi.fn(async () => undefined) };
  mocked.driver.mockReturnValue(driver); mocked.gateway.mockResolvedValue(gateway);
  mocked.fresh.mockResolvedValue({ readiness: { retainedTerms: [] } });
  return { root, child, driver, gateway };
}
afterEach(() => { vi.clearAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it.each(['bad-token', 'silent'] as const)('refuses %s readiness and cleans up its child before a model/gateway', async mode => {
  const f = fixture(mode); const run = vi.fn();
  await expect(launchPlanner({ root: f.root, deal: 'nimbus', port: 4646, readyTimeoutMs: 10, run })).rejects.toThrow(/token mismatch|timed out/);
  expect(f.child.kill).toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(mocked.gateway).not.toHaveBeenCalled();
});

it('latches console loss, aborts host work, and closes gateway and driver', async () => {
  const f = fixture();
  await expect(launchPlanner({ root: f.root, deal: 'nimbus', port: 4646, run: async (_gateway, signal) => {
    f.child.emit('disconnect'); expect(signal.aborted).toBe(true); return 'partial';
  } })).rejects.toThrow(/console exited or lost IPC/);
  expect(f.gateway.close).toHaveBeenCalledTimes(1); expect(f.driver.close).toHaveBeenCalledTimes(1);
});

it('preserves a model-construction failure while attempting every cleanup', async () => {
  const f = fixture(); f.gateway.close.mockRejectedValueOnce(new Error('close failed'));
  await expect(launchPlanner({ root: f.root, deal: 'nimbus', port: 4646, run: async () => { throw new Error('model construction failed'); } })).rejects.toThrow('model construction failed');
  expect(f.driver.close).toHaveBeenCalledTimes(1); expect(f.child.kill).toHaveBeenCalled();
});

it('passes only explicit caller/managed overrides to the gateway', async () => {
  const f = fixture();
  await launchPlanner({ root: f.root, deal: 'nimbus', port: 4646, run: async () => undefined });
  const env = (mocked.gateway.mock.calls[0]?.[0] as { env: Record<string, string> }).env;
  expect(env).not.toHaveProperty('PATH'); expect(env.GATE_HTTP).toBe('off');
});

it('rejects a gate HTTP override before forking any process', async () => {
  const f = fixture();
  await expect(launchPlanner({ root: f.root, deal: 'nimbus', port: 4646, env: { GATE_HTTP: 'on' }, run: vi.fn() })).rejects.toThrow('GATE_HTTP=off');
  expect(mocked.fork).not.toHaveBeenCalled();
});
