import { fileURLToPath } from 'node:url';
import { neo4jConfig, openDriver } from '../graph/connection.js';
import { resetDemo } from '../packages/harness/src/reset.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const graph = neo4jConfig();
const driver = openDriver(graph);
try { await resetDemo({ root, graph, driver, deal: 'nimbus' }); }
catch (error) { console.error(error instanceof Error ? error.message : 'reset failed'); process.exitCode = 1; }
finally { await driver.close(); }
