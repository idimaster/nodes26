import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { buildUiIfStale } from '../../../scripts/build-ui.js';
import { assertGraphEnvironment, graphEnvironment, neo4jConfig, openDriver, type ManagedConfig } from '../../../graph/connection.js';
import { gatewayDefinition } from './definition.js';
import { createGateway, cleanupAll } from './gateway.js';
import { acquireRunLock } from './lock.js';
import { assertFreshRun, inspectPlanningState } from './recovery.js';
import type { PlannerGateway } from './types.js';

export async function launchPlanner<T>(options: {
  root: string; deal: string; port: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; host?: 'pi' | 'openai-agents';
  readyTimeoutMs?: number; runId?: string;
  run: (gateway: PlannerGateway, signal: AbortSignal, inspect: () => ReturnType<typeof inspectPlanningState>) => Promise<T>;
}): Promise<T> {
  const env = options.env ?? process.env;
  const graph = neo4jConfig(env);
  const definition = gatewayDefinition(options.root);
  assertGraphEnvironment(graph, process.env, env, ...Object.values(definition.servers).map(s => s.env));
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('console port must be a TCP port');
  for (const source of [env, ...Object.values(definition.servers).map(s => s.env)]) if (source.GATE_HTTP && source.GATE_HTTP !== 'off') throw new Error('managed launch requires GATE_HTTP=off');
  const release = await acquireRunLock(options.root);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let fatal: Error | undefined;
  let cleaning = false;
  let driver: Driver | undefined;
  let gateway: PlannerGateway | undefined;
  let primary: unknown;
  let result: T | undefined;
  const errors: unknown[] = [];
  const closers: (() => Promise<unknown>)[] = [release];
  try {
    signal.throwIfAborted();
    await buildUiIfStale();
    const config: ManagedConfig = { graph, port: options.port, token: randomUUID() };
    const managedEnv = { ...graphEnvironment(graph), GATE_HTTP: 'off', GATE_PORT: String(config.port), PLANNER_MANAGED_TOKEN: config.token, PLANNER_MANAGED_CONFIG: JSON.stringify(config) };
    const childEnv = Object.fromEntries(Object.entries({ ...env, ...managedEnv }).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const child = fork(join(options.root, 'packages/gate/bin/console.ts'), [], { cwd: options.root, execArgv: ['--import', 'tsx'], env: childEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    closers.push(async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    });
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
    const fail = () => { if (!cleaning) { fatal ??= new Error(`managed console exited or lost IPC at 127.0.0.1:${config.port}; inspect graph before retry`); controller.abort(fatal); } };
    child.on('exit', fail); child.on('disconnect', fail); child.on('error', fail);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onExit = () => finish(new Error(`managed console failed to bind/connect at 127.0.0.1:${config.port} (stderr retained: ${diagnostics.length} bytes)`));
      const onAbort = () => finish(fatal ?? new Error('managed launch aborted'));
      const onMessage = (message: unknown) => {
        const m = message as { type?: string; token?: string; address?: string; port?: number; code?: string };
        if (m?.token !== config.token) return finish(new Error('managed console readiness token mismatch'));
        if (m.type === 'error') return finish(new Error(`managed console startup failed at 127.0.0.1:${config.port}: ${m.code ?? 'startup'}`));
        if (m.type !== 'ready' || m.address !== '127.0.0.1' || m.port !== config.port) return finish(new Error('invalid managed console readiness message'));
        finish();
      };
      const timer = setTimeout(() => finish(new Error(`managed console readiness timed out at 127.0.0.1:${config.port}`)), options.readyTimeoutMs ?? 20_000);
      child.on('message', onMessage); child.once('exit', onExit); signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    console.log(`console: open http://127.0.0.1:${config.port}/?deal=${encodeURIComponent(options.deal)}`);
    driver = openDriver(graph);
    // The CLI owns the driver; close after every gateway cleanup attempt.
    await driver.verifyConnectivity();
    const { readiness } = await assertFreshRun(driver, options.deal);
    console.log(`dataset: baseline verified; retained global terms: ${readiness.retainedTerms.join(', ') || 'none'}`);
    signal.throwIfAborted();
    const overrides = Object.fromEntries(Object.entries({ ...options.env, ...managedEnv }).filter((e): e is [string, string] => typeof e[1] === 'string'));
    gateway = await createGateway({ root: options.root, deal: options.deal, driver, graph, env: overrides, signal, runId: options.runId ?? randomUUID(), host: options.host ?? 'pi' });
    const ownedDriver = driver;
    result = await options.run(gateway, signal, () => inspectPlanningState(ownedDriver, options.deal));
    if (fatal) throw fatal;
    signal.throwIfAborted();
  } catch (error) {
    primary = error;
  } finally {
    cleaning = true; controller.abort();
    // Close children before releasing the local run lock, and the driver even if cleanup fails.
    try { if (gateway) await gateway.close(); } catch (error) { errors.push(error); }
    try { if (driver) await driver.close(); } catch (error) { errors.push(error); }
    try { await cleanupAll(closers.slice(1)); } catch (error) { errors.push(error); }
    try { await release(); } catch (error) { errors.push(error); }
  }
  if (primary !== undefined) {
    if (errors.length) console.error(`harness: ${errors.length} secondary cleanup failure(s)`);
    throw primary;
  }
  if (errors.length) throw new AggregateError(errors, 'harness cleanup failed');
  return result as T;
}
