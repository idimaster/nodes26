import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** T2.3: the official Neo4j MCP server, launched exactly as .mcp.json launches it. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, '.tools/neo4j-mcp/neo4j-mcp');

interface ServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, ServerEntry> };

async function connect(name: string): Promise<Client> {
  const entry = mcp.mcpServers[name];
  if (!entry) throw new Error(`.mcp.json has no ${name}`);
  const client = new Client({ name: `test-${name}`, version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), ...(entry.env ?? {}) },
      stderr: 'pipe',
    }),
  );
  return client;
}

const text = (r: { content: unknown }) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

describe('.mcp.json', () => {
  it('declares the two Neo4j instances, the engine, and the gate, with no secrets', () => {
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['gate', 'neo4j-read', 'neo4j-write', 'planner-engine']);
    expect(mcp.mcpServers['neo4j-read']).toEqual({ command: 'scripts/neo4j-mcp.sh', args: ['--read-only', 'true'] });
    expect(mcp.mcpServers['neo4j-write']).toEqual({ command: 'scripts/neo4j-mcp.sh', args: ['--read-only', 'false'] });
    expect(JSON.stringify(mcp)).not.toMatch(/password|planner-demo/i);
  });
});

describe('planner-engine as declared in .mcp.json', () => {
  it('starts and lists the engine tools', async () => {
    const client = await connect('planner-engine');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('compute_schedule');
    await client.close();
  }, 30_000);
});

describe('Neo4j MCP server (pinned binary)', () => {
  it('is installed (run: npm run mcp:neo4j:install)', () => {
    expect(existsSync(BIN), 'neo4j-mcp is not installed; run: npm run mcp:neo4j:install').toBe(true);
  });

  describe('neo4j-read', () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect('neo4j-read');
    }, 30_000);
    afterAll(async () => client?.close());

    it('serves only read tools', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get-schema', 'list-gds-procedures', 'read-cypher']);
    });

    it('get-schema returns the labels', async () => {
      const schema = text((await client.callTool({ name: 'get-schema', arguments: {} })) as { content: unknown });
      for (const label of ['Deal', 'Finding', 'Pattern', 'Task', 'UseCase']) expect(schema).toContain(label);
    });

    it('read-cypher answers a read and refuses a write', async () => {
      const read = await client.callTool({ name: 'read-cypher', arguments: { query: 'MATCH (d:Deal) RETURN d.code AS code ORDER BY code' } });
      expect(read.isError).toBeFalsy();
      expect(text(read as { content: unknown })).toContain('nimbus');
      const write = await client.callTool({ name: 'read-cypher', arguments: { query: "CREATE (:Probe {id: 'x'}) RETURN 1" } });
      expect(write.isError).toBe(true);
      expect(text(write as { content: unknown })).toMatch(/read-only/);
    });
  });

  describe('neo4j-write', () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect('neo4j-write');
    }, 30_000);
    afterAll(async () => client?.close());

    it('serves write-cypher, and a parameterized write round-trips', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('write-cypher');
      const set = await client.callTool({
        name: 'write-cypher',
        arguments: { query: 'MATCH (d:Deal {code: $deal}) SET d.mcp_probe = $v RETURN d.mcp_probe AS v', params: { deal: 'nimbus', v: 7 } },
      });
      expect(set.isError).toBeFalsy();
      expect(text(set as { content: unknown })).toContain('7');
      const unset = await client.callTool({
        name: 'write-cypher',
        arguments: { query: 'MATCH (d:Deal {code: $deal}) SET d.mcp_probe = null RETURN d.code AS code', params: { deal: 'nimbus' } },
      });
      expect(unset.isError).toBeFalsy();
    });
  });
});

describe('scripts/install-neo4j-mcp.sh', () => {
  it('refuses an archive whose SHA-256 does not match the pinned value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo4j-mcp-'));
    const fake = join(dir, 'fake.tar.gz');
    writeFileSync(fake, 'not the real archive');
    const result = spawnSync('scripts/install-neo4j-mcp.sh', [], {
      cwd: ROOT,
      env: { ...process.env, NEO4J_MCP_ARCHIVE: fake, NEO4J_MCP_INSTALL_DIR: join(dir, 'out') },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/);
    expect(existsSync(join(dir, 'out', 'neo4j-mcp'))).toBe(false);
  });
});

describe('scripts/neo4j-mcp.sh', () => {
  it('explains how to install when the binary is missing', () => {
    const result = spawnSync('scripts/neo4j-mcp.sh', ['--read-only', 'true'], {
      cwd: ROOT,
      env: { ...process.env, NEO4J_MCP_BIN: '/nonexistent/neo4j-mcp' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/npm run mcp:neo4j:install/);
  });
});
