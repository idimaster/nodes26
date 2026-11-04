import { Agent, MaxTurnsExceededError, Runner, type Model } from '@openai/agents';
import type { PlannerGateway } from '@planner/harness';
import { mapPlannerTools } from './tools.js';

export interface OpenAIRunResult { complete: boolean; requests: number; text: string; error?: string }
export interface PlannerEvent { type: 'tool_start' | 'tool_end'; canonicalName: string; providerName: string }

/** One in-memory conversation; resource ownership and graph reconciliation live in launchPlanner. */
export function createOpenAIPlanner(options: {
  gateway: PlannerGateway; model: Model; maxTurns?: number; signal?: AbortSignal;
  onEvent?: (event: PlannerEvent) => void;
}) {
  const maxTurns = options.maxTurns ?? 200;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer');
  const mapped = mapPlannerTools(options.gateway);
  const signal = options.signal ?? new AbortController().signal;
  let requests = 0;
  let used = false;
  const model: Model = {
    getResponse: async request => { request.signal?.throwIfAborted(); requests++; return options.model.getResponse(request); },
    getStreamedResponse: request => options.model.getStreamedResponse(request),
  };
  const agent = new Agent({ name: 'Integration planner', instructions: mapped.instructions, model, tools: mapped.tools, modelSettings: { parallelToolCalls: false } });
  const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
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
      try {
        signal.throwIfAborted();
        const result = await runner.run(agent, prompt, { maxTurns, signal });
        signal.throwIfAborted();
        if (result.interruptions.length || typeof result.finalOutput !== 'string') throw new Error('run stopped without final output');
        return { complete: true, requests, text: result.finalOutput };
      } catch (error) {
        const reason = error instanceof MaxTurnsExceededError ? `turn budget exhausted (${maxTurns})` : error instanceof Error ? error.message : String(error);
        return { complete: false, requests, text: '', error: `plan is incomplete: ${reason}` };
      }
    },
  };
}
