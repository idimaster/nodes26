import { Agent, MaxTurnsExceededError, Runner, type Model } from '@openai/agents';
import type { PlannerGateway } from '@planner/harness';
import { mapPlannerTools } from './tools.js';
import { reliableModel, type ProviderEvent } from './reliability.js';
import type { PlannerTracing } from './tracing.js';

export interface OpenAIRunResult { complete: boolean; requests: number; text: string; error?: string }
export interface PlannerEvent { type: 'tool_start' | 'tool_end'; canonicalName: string; providerName: string }

function describeFailure(error: unknown): string {
  const details = new Set<string>();
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  // Fetch/undici commonly nest socket codes beneath APIConnectionError -> TypeError,
  // sometimes inside AggregateError. Keep diagnostics bounded and omit nested messages/URLs.
  for (let n = 0; pending.length && n < 16; n++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Error) {
      if (value.name !== 'Error' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)) details.add(value.name);
      pending.push(value.cause);
      if (value instanceof AggregateError) pending.push(...value.errors.slice(0, 8));
    }
    if ('code' in value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) details.add(value.code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${message}${details.size ? ` (${[...details].join(', ')})` : ''}`;
}

/** One in-memory conversation; resource ownership and graph reconciliation live in launchPlanner. */
export function createOpenAIPlanner(options: {
  gateway: PlannerGateway; model: Model; maxTurns?: number; signal?: AbortSignal;
  onEvent?: (event: PlannerEvent) => void;
  onProviderEvent?: (event: ProviderEvent) => void;
  tracing?: PlannerTracing;
}) {
  const maxTurns = options.maxTurns ?? 200;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer');
  const tracing = options.tracing;
  tracing?.bindRunId(options.gateway.runId);
  const mapped = mapPlannerTools(options.gateway, tracing);
  const signal = options.signal ?? new AbortController().signal;
  let used = false;
  const provider = reliableModel({ model: options.model, maxTurns, ...(tracing ? { tracing } : {}), ...(options.onProviderEvent ? { onEvent: options.onProviderEvent } : {}) });
  const agent = new Agent({ name: 'Integration planner', instructions: mapped.instructions, model: provider.model, tools: mapped.tools, modelSettings: { parallelToolCalls: false, retry: provider.retry } });
  const runner = new Runner({ tracingDisabled: !tracing?.enabled, traceIncludeSensitiveData: false });
  const emit = (type: PlannerEvent['type'], providerName: string) => {
    const canonicalName = mapped.providerToCanonical.get(providerName);
    if (!canonicalName) throw new Error(`unmapped SDK tool event: ${providerName}`);
    options.onEvent?.({ type, canonicalName, providerName });
  };
  runner.on('agent_tool_start', (_context, _agent, tool) => emit('tool_start', tool.name));
  runner.on('agent_tool_end', (_context, _agent, tool) => emit('tool_end', tool.name));
  return {
    agent,
    async run(prompt: string): Promise<OpenAIRunResult> {
      if (used) throw new Error('one prompt per run; restart requires reconciliation');
      used = true;
      const execute = async (): Promise<OpenAIRunResult> => {
        try {
          signal.throwIfAborted();
          runner.config.tracingDisabled = !tracing?.enabled;
          const result = await runner.run(agent, prompt, { maxTurns, signal });
          signal.throwIfAborted();
          if (result.interruptions.length || typeof result.finalOutput !== 'string') throw new Error('run stopped without final output');
          tracing?.event('planner.result', { complete: true, requests: provider.requests });
          return { complete: true, requests: provider.requests, text: result.finalOutput };
        } catch (error) {
          const reason = error instanceof MaxTurnsExceededError ? `turn budget exhausted (${maxTurns})` : describeFailure(error);
          tracing?.event('planner.result', { complete: false, requests: provider.requests, aborted: signal.aborted });
          return { complete: false, requests: provider.requests, text: '', error: `plan is incomplete: ${reason}` };
        } finally { provider.endWaiting(signal.aborted ? signal.reason : undefined); }
      };
      return tracing ? tracing.scope(() => tracing.span('planner.run', {}, execute)) : execute();
    },
  };
}
