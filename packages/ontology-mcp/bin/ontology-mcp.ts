import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { GateStore } from '@planner/gate';
import { OntologyService } from '../src/service.js';

/** ontology MCP server: get_ontology and propose_term (DESIGN §2). The only writer of proposed OntologyTerms. */

const waitSeconds = Number(process.env.GATE_WAIT_SECONDS ?? 50);
if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 55) {
  console.error('ontology: GATE_WAIT_SECONDS must be an integer from 1 to 55');
  process.exit(1);
}
const driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'neo4j://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'planner-demo'),
);
const service = new OntologyService(driver, new GateStore(driver), { waitSeconds });
const reply = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid', message: e instanceof Error ? e.message : String(e) }) }],
});

const server = new McpServer({ name: 'ontology', version: '0.1.0' });
server.registerTool(
  'get_ontology',
  {
    description:
      'The labels and relationship types you may write for a deal: the core ontology (keys, required properties, enums, reserved labels) ' +
      'plus the active terms of global and this deal. Call it first; get-schema shows only what exists, not what is allowed.',
    inputSchema: z.object({ deal: z.string().min(1) }),
  },
  async ({ deal }) => {
    try {
      return reply(await service.getOntology(deal));
    } catch (e) {
      return fail(e);
    }
  },
);
server.registerTool(
  'propose_term',
  {
    description:
      `Propose a new label (UpperCamelCase) or relationship type (UPPER_SNAKE) when a finding needs a concept the ontology lacks. ` +
      `Writes a proposed term motivated by the given findings and asks the architect (an ontology_term gate), waiting up to ${waitSeconds}s. ` +
      'Returns {status, gate_id, term}; while pending, call gate await_approval. Usable for this deal only once approved.',
    inputSchema: z.object({
      deal: z.string().min(1),
      iteration: z.number().int().positive(),
      kind: z.enum(['label', 'relationship']),
      name: z.string().min(1),
      definition: z.string().min(1),
      example: z.string().min(1),
      motivated_by: z.array(z.string().min(1)),
    }),
  },
  async (input) => {
    try {
      return reply(await service.proposeTerm(input));
    } catch (e) {
      return fail(e);
    }
  },
);
await server.connect(new StdioServerTransport());
process.stdin.on('close', () => void driver.close().finally(() => process.exit(0)));
