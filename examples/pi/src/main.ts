import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchPlanner } from '@planner/harness';
import { createPiPlanner } from './agent.js';
import { modelFromEnv } from './model.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    deal: { type: 'string', default: 'nimbus' }, port: { type: 'string', default: process.env.GATE_PORT ?? '4646' },
    'max-steps': { type: 'string', default: '200' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { console.log('example:pi -- --deal nimbus [--port 4646] [--max-steps 200] "Plan the Nimbus integration."\nSet PLANNER_MODEL=anthropic:<id>|openai:<id> and the matching API key. The command owns its console; do not start demo:ui separately.'); return; }
  const maxSteps = Number(values['max-steps']);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps must be a positive integer');
  const provider = modelFromEnv(); // Fail bad provider/config before launching children.
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await launchPlanner({
      root: fileURLToPath(new URL('../../..', import.meta.url)), deal: values.deal, port: Number(values.port), signal: controller.signal,
      run: async (gateway, signal) => createPiPlanner({ ...provider, gateway, signal, maxSteps, onEvent: event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
        if (event.type === 'tool_execution_start') console.log(`\n→ ${event.toolName}`);
        if (event.type === 'tool_execution_end' && event.isError) console.error(`tool error: ${event.toolName}`);
      } }).run(positionals.join(' ') || `Plan the ${values.deal} integration.`),
    });
    console.log(`\n${result.requests} provider requests; ${result.complete ? 'complete' : 'incomplete'}`);
    if (!result.complete) throw new Error(result.error ?? 'plan incomplete');
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Pi planner failed'); process.exitCode = 1; });
