import { fileURLToPath } from 'node:url';
import { managedConfig, neo4jConfig, openDriver } from '../../../graph/connection.js';
import { createConsoleServer } from '../src/server.js';
import { GateStore } from '../src/store.js';

/**
 * Standalone gate console (npm run console). It serves the same page and API as the gate MCP
 * process, so the architect can open it before or without a Claude Code session. A gate MCP
 * process that starts later finds the port taken and keeps working through the graph.
 */

async function main() {
  const managed = managedConfig();
  if (managed && !process.send) throw new Error('managed console requires IPC');
  const port = managed?.port ?? Number(process.env.GATE_PORT ?? 4646);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GATE_PORT must be a TCP port');
  const driver = openDriver(managed?.graph ?? neo4jConfig());
  const http = createConsoleServer(new GateStore(driver), { port, driver, vizDist: fileURLToPath(new URL('../../../viz/dist', import.meta.url)) });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    http.closeAllConnections();
    await Promise.allSettled([new Promise<void>(resolve => http.close(() => resolve())), driver.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  if (managed) process.on('disconnect', () => { void shutdown(); });
  try {
    await driver.verifyConnectivity();
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', resolve);
    });
    if (managed) process.send?.({ type: 'ready', token: managed.token, address: '127.0.0.1', port });
    else console.log(`console: open http://127.0.0.1:${port}/ (Ctrl-C to stop)`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'GRAPH_CONNECT_FAILED';
    if (managed) process.send?.({ type: 'error', token: managed.token, code });
    http.close(); await driver.close();
    throw new Error(code === 'EADDRINUSE'
      ? `console: port ${port} is in use; a process already serves the console at http://127.0.0.1:${port}/`
      : `console: startup failed at 127.0.0.1:${port} (${code})`, { cause: error });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'console: startup failed'); process.exitCode = 1; });
