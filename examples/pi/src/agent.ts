import { Agent, type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { PlannerGateway, ToolOutcome } from '@planner/harness';

export interface PiRunResult { complete: boolean; requests: number; text: string; error?: string }

function failedStream(model: Model<Api>, reason: string, aborted = false) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? 'aborted' : 'error', errorMessage: reason, timestamp: Date.now(),
  };
  stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message }); stream.end(message);
  return stream;
}

/** Runtime adapter only: all tool policy and execution belongs to the gateway. */
export function createPiPlanner(options: { gateway: PlannerGateway; model: Model<Api>; streamFn: StreamFn; maxSteps?: number; signal?: AbortSignal; onEvent?: (event: AgentEvent) => void }) {
  const maxSteps = options.maxSteps ?? 200;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive integer');
  let requests = 0;
  let failure: string | undefined;
  let used = false;
  const tools: AgentTool<object, ToolOutcome>[] = options.gateway.tools.map(descriptor => ({
    name: descriptor.canonicalName, label: descriptor.canonicalName, description: descriptor.description,
    parameters: descriptor.inputSchema,
    async execute(_id, input, signal) {
      try {
        const result = await options.gateway.invoke(descriptor.canonicalName, input, signal);
        const content = result.content.map(item => {
          if (item.type !== 'text') throw new Error(`unsupported MCP content: ${item.type}`);
          return { type: 'text' as const, text: item.text };
        });
        // Structured-only witnesses must also reach the model, not just UI details.
        if (result.structuredContent) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
        return { content, details: result, isError: result.isError === true || result.denied === true };
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error);
        agent.abort();
        throw error;
      }
    },
  }));
  const agent = new Agent({
    initialState: { systemPrompt: options.gateway.instructions, model: options.model, tools },
    toolExecution: 'sequential',
    streamFn: async (model, context, streamOptions) => {
      if (failure || options.signal?.aborted || streamOptions?.signal?.aborted) return failedStream(model, failure ?? 'run aborted', true);
      if (requests >= maxSteps) { failure = `provider request budget exhausted (${maxSteps}); plan is incomplete`; return failedStream(model, failure); }
      requests++;
      try { return await options.streamFn(model, context, streamOptions); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); return failedStream(model, failure); }
    },
    afterToolCall: async ({ result, isError }) => {
      const outcome = result.details as ToolOutcome | undefined;
      return { isError: isError || outcome?.isError === true || outcome?.denied === true };
    },
  });
  if (options.onEvent) agent.subscribe(options.onEvent);
  return {
    agent,
    async run(prompt: string): Promise<PiRunResult> {
      if (used) throw new Error('one prompt per run; restart requires reconciliation');
      used = true;
      const abort = () => { failure ??= 'run aborted'; agent.abort(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        if (options.signal?.aborted) abort(); else await agent.prompt(prompt);
      } catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
      finally { options.signal?.removeEventListener('abort', abort); }
      const messages = agent.state.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
      const last = messages.at(-1);
      const terminalError = last?.stopReason === 'error' || last?.stopReason === 'aborted';
      const error = failure ?? agent.state.errorMessage ?? (terminalError ? last.errorMessage ?? last.stopReason : undefined);
      const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
      return { complete: !error, requests, text, ...(error ? { error } : {}) };
    },
  };
}
