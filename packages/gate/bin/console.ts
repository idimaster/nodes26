import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { createConsoleServer } from '../src/server.js';
import { GateStore } from '../src/store.js';

/**
 * Standalone gate console (npm run console). It serves the same page and API as the gate MCP
 * process, so the architect can open it before or without a Claude Code session. A gate MCP
 * process that starts later finds the port taken and keeps working through the graph.
 */

const port = Number(process.env.GATE_PORT ?? 4646);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('console: GATE_PORT must be a TCP port');
  process.exit(1);
}
const driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'neo4j://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'planner-demo'),
);
const http = createConsoleServer(new GateStore(driver), fileURLToPath(new URL('../../../viz/gate.html', import.meta.url)), port);
http.on('error', (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `console: port ${port} is in use; a gate process already serves the console at http://127.0.0.1:${port}/`
      : `console: ${e.message}`,
  );
  process.exit(1);
});
http.listen(port, '127.0.0.1', () => console.log(`console: open http://127.0.0.1:${port}/ (Ctrl-C to stop)`));

const shutdown = () => {
  http.close();
  void driver.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
