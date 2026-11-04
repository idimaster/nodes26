import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createPiPlanner } from '../../examples/pi/src/agent.js';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { readRecording } from '../../graph/replay/format.js';
import { expectations } from '../../graph/replay/snapshot.js';
import { launchPlanner } from '../../packages/harness/src/launch.js';
import { plannerDefinition } from '../../packages/harness/src/definition.js';

const root = new URL('../..', import.meta.url).pathname;
const driver = openDriver();
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
});
beforeEach(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await loadAll(driver); });
afterAll(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await loadAll(driver); await driver.close(); });

it('refuses any occupied console port before exposing tools or running a provider', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = vi.fn();
  try { await expect(launchPlanner({ root, deal: 'nimbus', port, run })).rejects.toThrow(/console.*(startup|bind|exited)/); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  expect(run).not.toHaveBeenCalled();
});

it('binds all real MCP tools, denies a destructive write, and cleans up its owned console', async () => {
  const port = await freePort();
  await launchPlanner({ root, deal: 'nimbus', port, run: async gateway => {
    expect(gateway.tools.map(t => t.canonicalName).sort()).toEqual(plannerDefinition(root).tools.sort());
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('mcp__neo4j-write__write-cypher', { query: 'MATCH (n) DETACH DELETE n RETURN 1', params: { deal: 'nimbus' } }, { id: 'denied' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('The destructive write was refused.'),
    ]);
    const planner = createPiPlanner({ gateway, model: faux.getModel(), streamFn: models.streamSimple.bind(models) });
    expect(await planner.run('Plan Nimbus')).toMatchObject({ complete: true, requests: 2 });
    expect(planner.agent.state.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', isError: true, details: expect.objectContaining({ denied: true }) })]));
  } });
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
});

it.each(['nimbus-v1', 'nimbus-p4'])('drives %s through Pi with scripted provider calls and architect HTTP decisions', async name => {
  const recording = readRecording(join(root, `data/replays/${name}.jsonl`));
  const port = await freePort();
  const decisions = new Map(recording.decisions.map(d => [d.gate_id, d]));
  const decided = new Set<string>();
  let deciding = false;
  let decisionFailure: unknown;
  const timer = setInterval(() => {
    if (deciding) return;
    deciding = true;
    void (async () => {
      // Console startup precedes the provider; an early connection refusal is expected.
      let response: Response;
      try { response = await fetch(`http://127.0.0.1:${port}/api/gates?status=pending&deal=nimbus`); }
      catch { return; }
      const gates = await response.json() as { id: string }[];
      for (const gate of gates) {
        if (decided.has(gate.id)) continue;
        const decision = decisions.get(gate.id);
        if (!decision) throw new Error(`unexpected gate ${gate.id}`);
        const result = await fetch(`http://127.0.0.1:${port}/api/gates/${gate.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision) });
        if (!result.ok) throw new Error(`architect decision failed: ${result.status}`);
        decided.add(gate.id);
      }
    })().catch(error => { decisionFailure = error; }).finally(() => { deciding = false; });
  }, 50);
  try {
    await launchPlanner({ root, deal: 'nimbus', port, env: { ...process.env, GATE_WAIT_SECONDS: '5' }, run: async (gateway, signal) => {
      const faux = fauxProvider({ tokensPerSecond: Infinity });
      const models = createModels(); models.setProvider(faux.provider);
      faux.setResponses([
        ...recording.calls.map(call => fauxAssistantMessage(fauxToolCall(`mcp__${call.server}__${call.tool}`, call.args as Parameters<typeof fauxToolCall>[1], { id: `call-${call.seq}` }), { stopReason: 'toolUse', timestamp: 1 })),
        fauxAssistantMessage('The roadmap is committed.', { timestamp: 1 }),
      ]);
      const planner = createPiPlanner({ gateway, signal, model: faux.getModel(), streamFn: models.streamSimple.bind(models) });
      expect(await planner.run('Plan the Nimbus integration.')).toMatchObject({ complete: true });
      expect(planner.agent.state.messages.filter(m => m.role === 'toolResult' && m.isError)).toEqual([]);
      expect(await expectations(driver, 'nimbus')).toEqual(recording.header.expect);
    } });
    expect(decisionFailure).toBeUndefined();
    expect(decided.size).toBe(decisions.size);
  } finally { clearInterval(timer); }
}, 90_000);

it('has a synchronized prompt rather than registering ambient coding tools', () => {
  expect(plannerDefinition(root).instructions).toContain(readFileSync(join(root, 'plugin/skills/plan-integration/SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim().slice(0, 100));
});
