import { runCli } from './cli.js';

runCli().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'OpenAI planner failed'); process.exitCode = 1; });
