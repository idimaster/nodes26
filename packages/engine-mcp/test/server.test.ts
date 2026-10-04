import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import raw from '../../../config/thresholds.json' with { type: 'json' };
import { computeSchedule, thresholdsSchema } from '@planner/engine';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const SERVER = 'packages/engine-mcp/src/server.ts';

const TOOLS = [
  'analyze_pattern_fit',
  'classify_buy_build',
  'classify_finding',
  'compute_schedule',
  'cypher_template',
  'estimate_provenance',
  'instantiate_tasks',
  'recommend_strategy',
];

function connect(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [SERVER],
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'engine-mcp-test', version: '0.0.0' });
  return { client, transport };
}

const payload = (result: { content: unknown }) => {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? 'null') as unknown;
};

describe('planner-engine MCP server (T2.2)', () => {
  const { client, transport } = connect();

  beforeAll(async () => {
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('lists exactly the DESIGN §2 engine tools, each with an object input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.description, t.name).toBeTruthy();
    }
  });

  it('round-trips compute_schedule, matching a direct engine call', async () => {
    const plan_tasks = [
      { id: 'a', weeks_o: 1, weeks_e: 2, weeks_p: 3 },
      { id: 'b', weeks_o: 2, weeks_e: 3, weeks_p: 10 },
    ];
    const depends_on = [{ from: 'b', to: 'a' }];
    const result = await client.callTool({ name: 'compute_schedule', arguments: { plan_tasks, depends_on } });
    expect(result.isError).toBeFalsy();
    expect(payload(result as { content: unknown })).toEqual(computeSchedule(plan_tasks, depends_on));
    expect(result.structuredContent).toEqual({ result: computeSchedule(plan_tasks, depends_on) });
  });

  it('accepts extra fields on plan tasks, so instantiate_tasks output can be passed straight through', async () => {
    const out = payload(
      (await client.callTool({
        name: 'instantiate_tasks',
        arguments: {
          deal: 'nimbus',
          iteration: 1,
          selections: [
            {
              uc: 'u1',
              pattern: 'p',
              requires: [],
              tasks: [
                { id: 'p.a', weeks_o: 1, weeks_e: 1, weeks_p: 2, skill: 'ops', depends_on: [] },
                { id: 'p.b', weeks_o: 1, weeks_e: 2, weeks_p: 3, skill: 'ops', depends_on: ['p.a'] },
              ],
            },
          ],
        },
      })) as { content: unknown },
    ) as { plan_tasks: unknown[]; depends_on: unknown[] };
    const schedule = await client.callTool({ name: 'compute_schedule', arguments: out });
    expect(schedule.isError).toBeFalsy();
    expect((payload(schedule as { content: unknown }) as { finish: number }).finish).toBe(3);
  });

  it('returns a cycle as a tool error with its witness', async () => {
    const result = await client.callTool({
      name: 'compute_schedule',
      arguments: {
        plan_tasks: [
          { id: 'x', weeks_o: 1, weeks_e: 1, weeks_p: 1 },
          { id: 'y', weeks_o: 1, weeks_e: 1, weeks_p: 1 },
        ],
        depends_on: [
          { from: 'x', to: 'y' },
          { from: 'y', to: 'x' },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(payload(result as { content: unknown })).toMatchObject({ error: 'cycle', witness: ['x', 'y', 'x'] });
  });

  it('classifies a batch of findings with the configured thresholds', async () => {
    const result = await client.callTool({
      name: 'classify_finding',
      arguments: {
        findings: [
          { id: 'f1', kind: 'gap', evidence_type: 'code_inspection', confidence: 0.9 },
          { id: 'f2', kind: 'gap', evidence_type: 'interview', confidence: 0.9 },
        ],
      },
    });
    expect(payload(result as { content: unknown })).toEqual([
      { id: 'f1', classified_as: 'gap' },
      { id: 'f2', classified_as: 'assumption' },
    ]);
  });

  it('serves a template, and the template catalog when no name is given', async () => {
    const one = payload(
      (await client.callTool({ name: 'cypher_template', arguments: { name: 'write_selections' } })) as { content: unknown },
    );
    expect(one).toMatchObject({ name: 'write_selections', destructive: false, query: expect.stringContaining('MERGE') });
    const catalog = payload((await client.callTool({ name: 'cypher_template', arguments: {} })) as { content: unknown });
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'replace_selection', destructive: true })]));
  });

  it('reports invalid input and engine errors as tool errors, not crashes', async () => {
    const bad = await client.callTool({ name: 'cypher_template', arguments: { name: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/unknown template/);
    const invalid = await client.callTool({ name: 'compute_schedule', arguments: { plan_tasks: 'nope' } });
    expect(invalid.isError).toBe(true);
    // The server is still alive.
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
  });
});

describe('planner-engine MCP startup', () => {
  it('refuses to start with invalid thresholds (no silent defaults)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'th-'));
    const file = join(dir, 'thresholds.json');
    const broken = { ...thresholdsSchema.parse(raw), classify: { min_confidence: 2 } };
    writeFileSync(file, JSON.stringify(broken));
    const { client, transport } = connect({ THRESHOLDS_FILE: file });
    await expect(client.connect(transport)).rejects.toThrow();
  }, 30_000);
});
