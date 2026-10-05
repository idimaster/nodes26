import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Starts the .mcp.json servers over stdio, as Claude Code does, and calls their tools (replay and the e2e harness). */

export interface Servers {
  /** Calls a tool and returns its parsed JSON result; a tool error throws. */
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

export async function startServers(root: string, env: Record<string, string>, only?: string[]): Promise<Servers> {
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args?: string[] }> };
  const clients: Record<string, Client> = {};
  for (const [name, entry] of Object.entries(mcp.mcpServers)) {
    if (only && !only.includes(name)) continue;
    const client = new Client({ name: `replay-${name}`, version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        cwd: root,
        env: { ...(process.env as Record<string, string>), ...env },
        stderr: 'ignore',
      }),
    );
    clients[name] = client;
  }
  return {
    call: async (server, tool, args) => {
      const client = clients[server];
      if (!client) throw new Error(`server ${server} is not in .mcp.json (or was not started)`);
      const r = await client.callTool({ name: tool, arguments: args });
      if (r.isError) throw new Error(`${server}.${tool} failed: ${text(r)}`);
      return JSON.parse(text(r));
    },
    close: async () => {
      for (const c of Object.values(clients)) await c.close();
    },
  };
}
