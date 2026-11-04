import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import { launchPlanner } from '@planner/harness';
import { createOpenAIPlanner } from './agent.js';
import { modelFromEnv } from './model.js';
import { createPlannerTracing, flushPlannerTracing, installPlannerTraceExporter } from './tracing.js';

export function plannerSignalHandlers(controller: AbortController) {
  const abort = () => controller.abort();
  // Remain registered until all cleanup/trace flush finishes: SDK signal handlers may exit
  // the process when they become the only remaining listener for the signal.
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  return () => { process.off('SIGINT', abort); process.off('SIGTERM', abort); };
}

export async function runCli(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    deal: { type: 'string', default: 'nimbus' }, port: { type: 'string', default: process.env.GATE_PORT ?? '4646' },
    'max-turns': { type: 'string', default: '200' }, trace: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('example:openai-agents -- --deal nimbus [--port 4646] [--max-turns 200] [--trace] "Plan the Nimbus integration."\nSet PLANNER_MODEL=openai:<model-id> and OPENAI_API_KEY. --trace exports payload-free SDK traces to OpenAI. The command owns its console; do not start demo:ui separately.');
    return;
  }
  const maxTurns = Number(values['max-turns']);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer');
  const config = modelFromEnv(); // Validate before launching any children.
  if (values.trace && /^(1|true)$/i.test(process.env.OPENAI_AGENTS_DISABLE_TRACING ?? '')) throw new Error('--trace conflicts with OPENAI_AGENTS_DISABLE_TRACING');
  if (values.trace) installPlannerTraceExporter(config.apiKey);
  const tracing = createPlannerTracing({ enabled: values.trace, model: config.modelId, deal: values.deal });
  if (tracing.id) console.error(`trace: ${tracing.id}; dashboard: https://platform.openai.com/traces; Node ${process.version}; undici ${process.versions.undici ?? 'unknown'}`);
  const controller = new AbortController();
  const removeSignals = plannerSignalHandlers(controller);
  try {
    const result = await tracing.scope(() => tracing.span('planner.cli', {}, () => launchPlanner({
      host: 'openai-agents', root: fileURLToPath(new URL('../../..', import.meta.url)), deal: values.deal, port: Number(values.port), signal: controller.signal,
      run: async (gateway, signal, inspect) => {
        tracing.bindRunId(gateway.runId);
        if (tracing.id) console.error(`trace: ${tracing.id}; guard run: ${gateway.runId ?? 'unavailable'}`);
        // One retry owner: count every physical attempt in the Runner, including HTTP errors.
        const client = new OpenAI({ apiKey: config.apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0 });
        const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
        try {
          const model = await provider.getModel(config.modelId);
          const result = await createOpenAIPlanner({ gateway, signal, model, maxTurns, tracing, onProviderEvent: event => {
            console.error(`provider ${config.modelId}: ${event.type}; attempt ${event.attempt}${event.status ? `; HTTP ${event.status}` : ''}${event.delayMs !== undefined ? `; wait ${event.delayMs} ms` : event.type === 'retry' ? '; SDK exponential backoff' : ''}`);
          }, onEvent: event => {
            if (event.type === 'tool_start') console.log(`→ ${event.canonicalName}`);
          } }).run(positionals.join(' ') || `Plan the ${values.deal} integration.`);
          if (!result.complete) console.error(`Inspect with npm run planner:recover -- inspect --deal ${values.deal} before restarting.`);
          try { console.log(`graph state: ${JSON.stringify(await inspect())}`); }
          catch { throw new Error(`graph state unavailable; run npm run planner:recover -- inspect --deal ${values.deal} before restarting`); }
          return result;
        } finally { await provider.close(); }
      },
    })));
    console.log(`${result.requests} model requests; ${result.complete ? 'complete' : 'incomplete'}`);
    if (!result.complete) throw new Error(result.error ?? 'plan incomplete');
    console.log(result.text);
  } finally {
    try {
      if (values.trace) {
        try {
          const status = await flushPlannerTracing();
          if (status !== 'flushed') console.error(`trace export ${status}; planner result is unchanged`);
        } catch { console.error('trace export failed; planner result is unchanged'); }
      }
    } finally { removeSignals(); }
  }
}
