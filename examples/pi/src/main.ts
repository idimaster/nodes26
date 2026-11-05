import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCapture, type Capture } from '@planner/diagnostics';
import { launchPlanner } from '@planner/harness';
import { createPiPlanner } from './agent.js';
import { modelFromEnv } from './model.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    deal: { type: 'string', default: 'nimbus' }, port: { type: 'string', default: process.env.GATE_PORT ?? '4646' },
    'max-steps': { type: 'string', default: '200' }, diagnostics: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { console.log('example:pi -- --deal nimbus [--port 4646] [--max-steps 200] [--diagnostics metadata|off] "Plan the Nimbus integration."\nSet PLANNER_MODEL=anthropic:<id>|openai:<id> and the matching API key. The command owns its console; do not start demo:ui separately.'); return; }
  const policy = values.diagnostics ?? process.env.PLANNER_DIAGNOSTICS ?? 'metadata';
  if (policy !== 'metadata' && policy !== 'off') throw new Error('--diagnostics must be metadata or off');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const requestedModel = process.env.PLANNER_MODEL ?? 'anthropic:claude-sonnet-5-5';
  const separator = requestedModel.indexOf(':');
  const providerName = requestedModel.slice(0, separator);
  const modelName = requestedModel.slice(separator + 1);
  const safeSelection = ['anthropic', 'openai'].includes(providerName) && /^[A-Za-z0-9._-]{1,128}$/.test(modelName);
  let capture: Capture | undefined;
  try {
    capture = createCapture({ root, deal: values.deal, policy, provider: safeSelection ? providerName : null, model: safeSelection ? modelName : null });
    if (capture) console.error(`diagnostics: ${capture.relativePath}`);
  } catch { console.error('diagnostics capture unavailable'); }
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  let requests = 0;
  let httpAttempts = 0;
  let reasonCode: string | null = 'startup_failed';
  try {
  const maxSteps = Number(values['max-steps']);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps must be a positive integer');
  const provider = modelFromEnv(); // Fail bad provider/config before launching children.
  reasonCode = 'launch_failed';
  console.log(`model: ${provider.model.provider}:${provider.model.id}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await launchPlanner({
      root, deal: values.deal, port: Number(values.port), signal: controller.signal, ...(capture ? { runId: capture.runId } : {}),
      run: async (gateway, signal) => {
        reasonCode = 'run_failed';
        return createPiPlanner({ ...provider, gateway, signal, maxSteps, ...(capture ? { capture } : {}),
        onProviderStatus: event => console.error(`provider ${event.provider}: ${event.type}; attempt ${event.attempt}/4${event.kind ? ` (${event.kind})` : ''}${event.delayMs !== undefined ? `; wait ${event.delayMs} ms` : ''}`),
        onEvent: event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
        if (event.type === 'tool_execution_start') console.log(`\n→ ${event.toolName}`);
        if (event.type === 'tool_execution_end' && event.isError) console.error(`tool error: ${event.toolName}`);
      } }).run(positionals.join(' ') || `Plan the ${values.deal} integration.`);
      },
    });
    requests = result.requests;
    httpAttempts = result.httpAttempts;
    console.log(`\n${result.requests} provider attempts (including retries); ${result.complete ? 'complete' : 'incomplete'}`);
    if (!result.complete) { reasonCode = 'run_incomplete'; throw new Error(result.error ?? 'plan incomplete'); }
    outcome = 'completed'; reasonCode = null;
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
  } catch (error) {
    if (reasonCode === 'startup_failed' || reasonCode === 'launch_failed') capture?.error(error, 'host');
    throw error;
  } finally {
    capture?.finish({ outcome, reasonCode, providerAttempts: requests, httpAttempts });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Pi planner failed'); process.exitCode = 1; });
