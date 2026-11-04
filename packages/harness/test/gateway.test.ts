import { expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { createGateway, plannerDefinition, type Connection, type GuardAudit } from '../src/index.js';
import { cypherTemplate } from '@planner/engine';
import type { GateRecord, GuardContext } from '@planner/guard';

const root = new URL('../../..', import.meta.url).pathname;
const write = 'mcp__neo4j-write__write-cypher';
const schema = { type: 'object' as const, properties: { query: { type: 'string' }, params: { type: 'object' } }, required: ['query', 'params'] };
const input = { query: "MERGE (i:Iteration {deal_code: $deal, n: $n}) ON CREATE SET i.started_at = datetime(), i.status = 'draft' RETURN i.n AS n", params: { deal: 'nimbus', n: 1 } };

function fixture() {
  const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const closes: ReturnType<typeof vi.fn>[] = [];
  const connect = async (server: string): Promise<Connection> => {
    const close = vi.fn(async () => undefined);
    closes.push(close);
    return {
      listTools: async () => plannerDefinition(root).tools.filter(t => t.startsWith(`mcp__${server}__`)).map(t => ({ name: t.split('__')[2]!, inputSchema: t === write ? schema : { type: 'object' as const }, description: t })),
      callTool: call, close,
    };
  };
  const context = vi.fn(async (): Promise<GuardContext> => ({ activeTerms: [], lookupGate: async () => null }));
  return { call, closes, context, options: { root, driver: {} as Driver, deal: 'nimbus', connect, context, audit: async () => undefined } };
}

it('has exactly the canonical tools and includes the complete prompt once', () => {
  const definition = plannerDefinition(root);
  expect(definition.tools).toHaveLength(15);
  expect(definition.instructions.split('Ask through a gate, never only in chat')).toHaveLength(2);
});

it.each([null, { deal_code: 'nimbus', iteration: 1, gate: 'commit', status: 'rejected' }, { deal_code: 'quarry', iteration: 1, gate: 'commit', status: 'approved' }, { deal_code: 'nimbus', iteration: 2, gate: 'commit', status: 'approved' }])('G8 rejects an unusable commit approval: %j', async gate => {
  const f = fixture();
  f.context.mockResolvedValue({ activeTerms: [], lookupGate: async () => gate as GateRecord | null });
  const gateway = await createGateway(f.options);
  try {
    expect(await gateway.invoke(write, { query: cypherTemplate('commit_roadmap').query, params: { deal: 'nimbus', iteration: 1, version: 1, gate_id: 'commit-1' } })).toMatchObject({ denied: true, reason: expect.stringMatching(/G8/) });
    expect(f.call).not.toHaveBeenCalled();
  } finally { await gateway.close(); }
});

it('reads freshly approved ontology terms for the next write', async () => {
  const f = fixture();
  const gateway = await createGateway(f.options);
  const termInput = { query: 'MERGE (n:ResidencyRequirement {deal_code: $deal, id: $id}) RETURN n.id AS id', params: { deal: 'nimbus', id: 'eu-data' } };
  try {
    expect(await gateway.invoke(write, termInput)).toMatchObject({ denied: true, reason: expect.stringMatching(/G6/) });
    f.context.mockResolvedValue({ activeTerms: [{ kind: 'label', name: 'ResidencyRequirement', scope: 'nimbus' }], lookupGate: async () => null });
    expect(await gateway.invoke(write, termInput)).toMatchObject({ content: [{ text: 'ok' }] });
    expect(f.context).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenCalledTimes(1);
  } finally { await gateway.close(); }
});

it('cleans up all earlier clients when a later connection fails', async () => {
  const f = fixture();
  const connect = f.options.connect;
  let n = 0;
  f.options.connect = async server => {
    if (++n === 4) throw new Error('connect failed');
    const connection = await connect(server);
    if (n === 1) f.closes[0]!.mockRejectedValueOnce(new Error('close failed'));
    return connection;
  };
  await expect(createGateway(f.options)).rejects.toThrow('connect failed');
  expect(f.closes).toHaveLength(3);
  expect(f.closes.every(c => c.mock.calls.length === 1)).toBe(true);
});

it.each(['mcp__ontology__get_ontology', 'mcp__ontology__propose_term', 'mcp__planner-graph__schedule_plan', 'mcp__gate__resolve_feedback', 'mcp__gate__request_approval'])('binds top-level deal in %s', async name => {
  const f = fixture();
  const gateway = await createGateway(f.options);
  try { expect(await gateway.invoke(name, { deal: 'quarry' })).toMatchObject({ denied: true }); expect(f.call).not.toHaveBeenCalled(); }
  finally { await gateway.close(); }
});

it('denies destructive writes and mismatched deals before downstream calls; forwards valid arguments unchanged', async () => {
  const f = fixture();
  const gateway = await createGateway(f.options);
  try {
    expect(await gateway.invoke(write, { query: 'MATCH (n) DETACH DELETE n RETURN 1', params: { deal: 'nimbus' } })).toMatchObject({ denied: true, isError: true });
    expect(await gateway.invoke(write, { ...input, params: { deal: 'quarry' } })).toMatchObject({ denied: true });
    expect(await gateway.invoke(write, { query: 1 })).toMatchObject({ isError: true });
    expect(f.call).not.toHaveBeenCalled();
    expect(await gateway.invoke(write, input)).toMatchObject({ content: [{ text: 'ok' }] });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('write-cypher', input, expect.anything());
  } finally { await gateway.close(); }
  expect(f.closes.every(c => c.mock.calls.length === 1)).toBe(true);
});

it('fails closed on context failures and still attempts every close', async () => {
  const f = fixture();
  f.context.mockRejectedValueOnce(new Error('graph unavailable'));
  const gateway = await createGateway(f.options);
  f.closes[0]!.mockRejectedValueOnce(new Error('close failed'));
  await expect(gateway.invoke(write, input)).rejects.toThrow('graph unavailable');
  expect(f.call).not.toHaveBeenCalled();
  await expect(gateway.close()).rejects.toThrow(/cleanup/);
  await expect(gateway.close()).rejects.toThrow(/cleanup/);
  expect(f.closes.every(c => c.mock.calls.length === 1)).toBe(true);
});

it('does not execute aborted queued writes', async () => {
  const f = fixture();
  let release!: () => void;
  f.call.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ content: [] }); }));
  const gateway = await createGateway(f.options);
  const first = gateway.invoke(write, input);
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
  const controller = new AbortController();
  const queued = gateway.invoke(write, input, controller.signal);
  controller.abort();
  release();
  await first;
  await expect(queued).rejects.toThrow();
  expect(f.call).toHaveBeenCalledTimes(1);
  await gateway.close();
});

it('resolves gate-only waits through a trusted read and refuses a different deal', async () => {
  const f = fixture();
  const executeQuery = vi.fn(async () => ({ records: [{ get: () => 'quarry' }] }));
  f.options.driver = { executeQuery } as unknown as Driver;
  const gateway = await createGateway(f.options);
  try {
    expect(await gateway.invoke('mcp__gate__await_approval', { gate_id: 'existing-quarry-gate' })).toMatchObject({ denied: true, isError: true });
    expect(f.call).not.toHaveBeenCalled();
    expect(executeQuery).toHaveBeenCalledWith(expect.stringContaining('GateDecision'), { id: 'existing-quarry-gate' }, { routing: 'READ' });
  } finally { await gateway.close(); }
});

it.each(['missing', 'discovery-failed'])('cleans up when required tool discovery is %s', async mode => {
  const f = fixture(); const connect = f.options.connect;
  f.options.connect = async name => {
    const connection = await connect(name);
    if (name === 'neo4j-write') connection.listTools = async () => { if (mode === 'discovery-failed') throw new Error('discovery failed'); return []; };
    return connection;
  };
  await expect(createGateway(f.options)).rejects.toThrow(/allowlisted tools not served|discovery failed/);
  expect(f.closes.every(c => c.mock.calls.length === 1)).toBe(true);
});

it('audits both allow and deny without copying full params', async () => {
  const f = fixture();
  const entries: GuardAudit[] = [];
  const gateway = await createGateway({ ...f.options, runId: 'test-run', audit: async entry => { entries.push(entry); } });
  try {
    await gateway.invoke(write, { query: 'MATCH (n) DETACH DELETE n RETURN 1', params: { deal: 'nimbus', sensitive: 'private-value' } });
    await gateway.invoke(write, input);
    expect(entries.map(e => e.allow)).toEqual([false, true]);
    expect(entries[0]).toMatchObject({ runId: 'test-run', host: 'pi', canonicalName: write, deal: 'nimbus', rules: expect.arrayContaining(['G2']) });
    expect(JSON.stringify(entries)).not.toContain('private-value');
    expect(entries.every(e => !('params' in e))).toBe(true);
  } finally { await gateway.close(); }
});
