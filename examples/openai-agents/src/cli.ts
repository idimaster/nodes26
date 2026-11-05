import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { createCapture, projectError, type Capture } from '@planner/diagnostics';
import { launchPlanner } from '@planner/harness';
import { createOpenAIPlanner } from './agent.js';
import { modelFromEnv } from './model.js';
import { createPlannerTracing, installLocalDiagnostics } from './local-tracing.js';
import { createProviderTransport, shouldRotateProviderTransport } from '../../pi/src/provider-transport.js';

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
    'max-turns': { type: 'string', default: '200' }, diagnostics: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('example:openai-agents -- --deal nimbus [--port 4646] [--max-turns 200] [--diagnostics metadata|off] "Plan the Nimbus integration."\nSet PLANNER_MODEL=openai:<model-id> and OPENAI_API_KEY. The command owns its console; do not start demo:ui separately.');
    return;
  }
  const maxTurns = Number(values['max-turns']);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer');
  const config = modelFromEnv(); // Validate before launching any children.
  const policy = values.diagnostics ?? process.env.PLANNER_DIAGNOSTICS ?? 'metadata';
  if (policy !== 'metadata' && policy !== 'off') throw new Error('--diagnostics must be metadata or off');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  let capture: Capture | undefined;
  try {
    capture = createCapture({ root, deal: values.deal, host: 'openai-agents', provider: 'openai', model: config.modelId,
      endpoint: { scheme: 'https', hostname: 'api.openai.com', port: null, path: '/v1/responses' }, policy });
    if (capture) console.error(`diagnostics: ${capture.relativePath}`);
  } catch { console.error('diagnostics capture unavailable'); }
  installLocalDiagnostics(capture);
  const tracing = createPlannerTracing(capture);
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  let requests = 0;
  let httpAttempts = 0;
  const controller = new AbortController();
  const removeSignals = plannerSignalHandlers(controller);
  try {
    const result = await tracing.scope(() => tracing.span('planner.cli', {}, () => launchPlanner({
      host: 'openai-agents', root, deal: values.deal, port: Number(values.port), signal: controller.signal, ...(capture ? { runId: capture.runId } : {}),
      run: async (gateway, signal, inspect) => {
        tracing.bindRunId(gateway.runId);
        // One retry owner: count every physical attempt in the Runner, including HTTP errors.
        const transport = createProviderTransport();
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const attemptId = randomUUID();
          const clientId = randomUUID();
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (capture && !headers.has('X-Client-Request-Id')) headers.set('X-Client-Request-Id', clientId);
          const endpoint = { scheme: 'https', hostname: 'api.openai.com', port: null, path: '/v1/responses' };
          httpAttempts++;
          capture?.emit('provider.http.started', { client_request_id: headers.get('X-Client-Request-Id') ?? clientId,
            endpoint, turn_attempt_index: 1, budget_attempt_index: httpAttempts, http_attempt_index: httpAttempts, body_bytes: null },
          { context: { http_attempt_id: attemptId } });
          const started = performance.now();
          try {
            const response = await transport.fetch(input, { ...init, headers });
            const headerNames = ['x-request-id', 'retry-after', 'retry-after-ms', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens', 'x-ratelimit-limit-project-tokens', 'x-ratelimit-remaining-project-tokens'];
            const safeHeader = (name: string) => { const value = response.headers.get(name); return value && /^[!-~]{1,256}$/.test(value) ? value : null; };
            capture?.emit('provider.http.received', { status: response.status, headers_ms: Math.max(0, performance.now() - started),
              request_id: safeHeader('x-request-id'), headers: Object.fromEntries(headerNames.map(name => [name, safeHeader(name)])) },
            { context: { http_attempt_id: attemptId } });
            return response;
          }
          catch (error) {
            capture?.emit('provider.failed', { phase: 'fetch', error: projectError(error, 'fetch'), http_status: null,
              request_id: null, response_id: null, last_event_type: null, raw_completed_seen: false },
            { context: { http_attempt_id: attemptId } });
            if (!init?.signal?.aborted && shouldRotateProviderTransport(error)) transport.rotate();
            throw error;
          }
        };
        const client = new OpenAI({ apiKey: config.apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0, fetch });
        const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
        try {
          const model = await provider.getModel(config.modelId);
          const result = await createOpenAIPlanner({ gateway, signal, model, maxTurns, tracing, onProviderEvent: event => {
            console.error(`provider ${config.modelId}: ${event.type}; attempt ${event.attempt}${event.status ? `; HTTP ${event.status}` : ''}${event.delayMs !== undefined ? `; wait ${event.delayMs} ms` : event.type === 'retry' ? '; SDK exponential backoff' : ''}`);
          }, onEvent: event => {
            if (event.type === 'tool_start') console.log(`→ ${event.canonicalName}`);
          } }).run(positionals.join(' ') || `Plan the ${values.deal} integration.`);
          requests = result.requests;
          if (!result.complete) console.error(`Inspect with npm run planner:recover -- inspect --deal ${values.deal} before restarting.`);
          try { console.log(`graph state: ${JSON.stringify(await inspect())}`); }
          catch { throw new Error(`graph state unavailable; run npm run planner:recover -- inspect --deal ${values.deal} before restarting`); }
          return result;
        } finally {
          try { await provider.close(); }
          finally { await transport.close(); }
        }
      },
    })));
    console.log(`${result.requests} model requests; ${result.complete ? 'complete' : 'incomplete'}`);
    if (!result.complete) throw new Error(result.error ?? 'plan incomplete');
    console.log(result.text);
    outcome = 'completed';
  } finally {
    capture?.finish({ outcome: controller.signal.aborted ? 'cancelled' : outcome, providerAttempts: requests, httpAttempts });
    removeSignals();
  }
}
