import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from '@openai/agents';
import { launchPlanner } from '@planner/harness';
import { createOpenAIPlanner } from './agent.js';
import { modelFromEnv } from './model.js';

export async function runCli(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    deal: { type: 'string', default: 'nimbus' }, port: { type: 'string', default: process.env.GATE_PORT ?? '4646' },
    'max-turns': { type: 'string', default: '200' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('example:openai-agents -- --deal nimbus [--port 4646] [--max-turns 200] "Plan the Nimbus integration."\nSet PLANNER_MODEL=openai:<model-id> and OPENAI_API_KEY. The command owns its console; do not start demo:ui separately.');
    return;
  }
  const maxTurns = Number(values['max-turns']);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer');
  const config = modelFromEnv(); // Validate before launching any children.
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await launchPlanner({
      host: 'openai-agents', root: fileURLToPath(new URL('../../..', import.meta.url)), deal: values.deal, port: Number(values.port), signal: controller.signal,
      run: async (gateway, signal, inspect) => {
        const provider = new OpenAIProvider({ apiKey: config.apiKey, baseURL: 'https://api.openai.com/v1', useResponses: true });
        try {
          const model = await provider.getModel(config.modelId);
          const result = await createOpenAIPlanner({ gateway, signal, model, maxTurns, onEvent: event => {
            if (event.type === 'tool_start') console.log(`→ ${event.canonicalName}`);
          } }).run(positionals.join(' ') || `Plan the ${values.deal} integration.`);
          if (!result.complete) console.error(`Inspect with npm run planner:recover -- inspect --deal ${values.deal} before restarting.`);
          try { console.log(`graph state: ${JSON.stringify(await inspect())}`); }
          catch { throw new Error(`graph state unavailable; run npm run planner:recover -- inspect --deal ${values.deal} before restarting`); }
          return result;
        } finally { await provider.close(); }
      },
    });
    console.log(`${result.requests} model requests; ${result.complete ? 'complete' : 'incomplete'}`);
    if (!result.complete) throw new Error(result.error ?? 'plan incomplete');
    console.log(result.text);
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
