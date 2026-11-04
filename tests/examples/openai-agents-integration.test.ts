import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { cypherTemplate } from '@planner/engine';
import { createOpenAIPlanner } from '../../examples/openai-agents/src/agent.js';
import { mapPlannerTools } from '../../examples/openai-agents/src/tools.js';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { readRecording } from '../../graph/replay/format.js';
import { expectations } from '../../graph/replay/snapshot.js';
import { launchPlanner, plannerDefinition } from '../../packages/harness/src/index.js';
import { answer, scriptedModel, toolCall } from './helpers/openai-model.js';

const root = new URL('../..', import.meta.url).pathname;
const driver = openDriver();
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
});
beforeEach(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await loadAll(driver); });
afterAll(async () => { await driver.executeQuery('MATCH (n) DETACH DELETE n'); await loadAll(driver); await driver.close(); });

it('routes real schemas, invalid arguments, denied writes and a valid template through the SDK and owned harness', async () => {
  const port = await freePort();
  const outcomes: unknown[] = [];
  await launchPlanner({ host: 'openai-agents', root, deal: 'nimbus', port, run: async (gateway, signal) => {
    expect(gateway.tools.map(t => t.canonicalName).sort()).toEqual(plannerDefinition(root).tools.sort());
    const mapping = mapPlannerTools(gateway);
    const calls = [
      ['mcp__neo4j-write__write-cypher', { query: 1, params: { deal: 'nimbus' } }],
      ['mcp__neo4j-write__write-cypher', { query: 'MATCH (n) DETACH DELETE n RETURN 1', params: { deal: 'nimbus' } }],
      ['mcp__neo4j-read__read-cypher', { query: 'RETURN $nested AS value', params: { deal: 'nimbus', nested: [{ items: [1, null, { enabled: true }] }] } }],
      ['mcp__neo4j-write__write-cypher', { query: cypherTemplate('create_iteration').query, params: { deal: 'nimbus', n: 1, started_at: '2026-01-01T00:00:00Z' } }],
    ] as const;
    const invoke = gateway.invoke.bind(gateway);
    const observed = { ...gateway, invoke: async (...args: Parameters<typeof invoke>) => { const result = await invoke(...args); outcomes.push(result); return result; } };
    const fake = scriptedModel((_request, index) => {
      const call = calls[index];
      return call ? toolCall(mapping.canonicalToProvider.get(call[0])!, call[1], `call-${index}`) : answer();
    });
    expect(await createOpenAIPlanner({ gateway: observed, signal, model: fake.model }).run('Plan Nimbus')).toMatchObject({ complete: true, requests: 5 });
    expect(outcomes).toEqual([
      expect.objectContaining({ denied: true, reason: expect.stringContaining('invalid tool arguments') }),
      expect.objectContaining({ denied: true }),
      expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('enabled') })]) }),
      expect.not.objectContaining({ isError: true }),
    ]);
    expect(fake.requests[0]!.tools).toHaveLength(15);
    for (const tool of fake.requests[0]!.tools) {
      expect(tool.type).toBe('function');
      if (tool.type === 'function') expect(tool.parameters).toEqual(gateway.tools.find(t => t.canonicalName === mapping.providerToCanonical.get(tool.name))!.inputSchema);
    }
  } });
  expect((await driver.executeQuery('MATCH (i:Iteration {deal_code: $deal}) RETURN count(i) AS n', { deal: 'nimbus' })).records[0]!.get('n').toNumber()).toBe(1);
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
});

it.each(['nimbus-v1', 'nimbus-p4'])('drives %s through OpenAI SDK with scripted calls and architect HTTP decisions', async name => {
  const recording = readRecording(join(root, `data/replays/${name}.jsonl`));
  const port = await freePort();
  const decisions = new Map(recording.decisions.map(d => [d.gate_id, d]));
  const decided = new Set<string>();
  let deciding: Promise<void> | undefined;
  let decisionFailure: unknown;
  const timer = setInterval(() => {
    if (deciding) return;
    deciding = (async () => {
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
    })().catch(error => { decisionFailure = error; }).finally(() => { deciding = undefined; });
  }, 50);
  try {
    await launchPlanner({ host: 'openai-agents', root, deal: 'nimbus', port, env: { ...process.env, GATE_WAIT_SECONDS: '5' }, run: async (gateway, signal) => {
      const mapping = mapPlannerTools(gateway);
      const fake = scriptedModel((_request, index) => {
        const call = recording.calls[index];
        return call ? toolCall(mapping.canonicalToProvider.get(`mcp__${call.server}__${call.tool}`)!, call.args, `call-${call.seq}`) : answer('The roadmap is committed.');
      });
      expect(await createOpenAIPlanner({ gateway, signal, model: fake.model }).run('Plan the Nimbus integration.')).toMatchObject({ complete: true });
      const lastInput = JSON.stringify(fake.requests.at(-1)!.input);
      expect(lastInput).not.toContain('"isError":true');
      expect(await expectations(driver, 'nimbus')).toEqual(recording.header.expect);
    } });
    expect(decisionFailure).toBeUndefined();
    expect(decided.size).toBe(decisions.size);
  } finally { clearInterval(timer); await deciding; }
}, 90_000);
