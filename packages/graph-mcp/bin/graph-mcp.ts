import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { gdsAvailable, scheduleIteration } from '../src/schedule.js';

/**
 * planner-graph: trusted graph computations the agent asks for but cannot fake. It writes only the
 * schedule fields of PlanTasks (DESIGN §2, §5.2). The GDS capability is probed once, at startup.
 */

const driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'neo4j://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'planner-demo'),
);
const forceKahn = process.env.PLANNER_SCHEDULER === 'kahn';
const gds = forceKahn ? false : await gdsAvailable(driver);
console.error(
  gds
    ? 'planner-graph: scheduling with gds.dag.longestPath.stream'
    : `planner-graph: ${forceKahn ? 'PLANNER_SCHEDULER=kahn' : 'gds.dag.longestPath.stream is not available'}; scheduling with the engine's Kahn algorithm`,
);

const server = new McpServer({ name: 'planner-graph', version: '0.1.0' });
server.registerTool(
  'schedule_plan',
  {
    description:
      "Schedule an iteration's plan in the graph: checks V3 first, then computes earliest starts, waves, and the critical path " +
      '(GDS longest path, or Kahn), writes them on every PlanTask, and returns finish, critical path, PERT band, and resource load. ' +
      'A cycle returns {status: "cycle", witness} and writes nothing.',
    inputSchema: z.object({ deal: z.string().min(1), iteration: z.number().int().positive() }),
  },
  async ({ deal, iteration }) => {
    try {
      const result = await scheduleIteration(driver, deal, iteration, { probe: async () => gds });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'invalid', message: e instanceof Error ? e.message : String(e) }) }] };
    }
  },
);
await server.connect(new StdioServerTransport());
process.stdin.on('close', () => void driver.close().finally(() => process.exit(0)));
