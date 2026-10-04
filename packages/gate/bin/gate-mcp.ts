import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import neo4j from 'neo4j-driver';
import { createConsoleServer, createGateMcpServer } from '../src/server.js';
import { GateStore } from '../src/store.js';

/**
 * Gate server: MCP over stdio for the agent, and the console on http://127.0.0.1:$GATE_PORT for
 * the architect. If the port is taken (another gate process serves the console), this process
 * still works: decisions land in the graph, and every long-poll re-checks the graph each second.
 */

const port = Number(process.env.GATE_PORT ?? 4646);
const waitSeconds = Number(process.env.GATE_WAIT_SECONDS ?? 50);
if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 55) {
  console.error('gate: GATE_WAIT_SECONDS must be an integer from 1 to 55 (below the 60 s MCP tool timeout)');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('gate: GATE_PORT must be a TCP port');
  process.exit(1);
}
const consoleHtml = fileURLToPath(new URL('../../../viz/gate.html', import.meta.url));

const driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'neo4j://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'planner-demo'),
);
const store = new GateStore(driver);

const http = createConsoleServer(store, consoleHtml, port);
http.on('error', (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `gate: port ${port} is in use; another gate process serves the console. Continuing without it.`
      : `gate: console server error: ${e.message}`,
  );
});
http.listen(port, '127.0.0.1', () => console.error(`gate: console at http://127.0.0.1:${port}/`));

await createGateMcpServer(store, waitSeconds).connect(new StdioServerTransport());
console.error(`gate: ready (long-poll ${waitSeconds}s)`);

const shutdown = () => {
  http.close();
  void driver.close().finally(() => process.exit(0));
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
