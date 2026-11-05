import {
  createCustomSpan, getCurrentTrace, setTraceProcessors, withCustomSpan, withTrace,
  type ModelRequest, type ModelResponse, type TracingProcessor,
} from '@openai/agents';
import { newSpanId, type Capture } from '@planner/diagnostics';

export interface TraceInterval { end(error?: unknown): void }

function localProcessor(capture: Capture): TracingProcessor {
  const ids = new Map<string, string>();
  const started = new Map<string, number>();
  const id = (native: string) => {
    let value = ids.get(native);
    if (!value) { value = newSpanId(); ids.set(native, value); }
    return value;
  };
  const name = (data: { type: string; name?: string }) => {
    if (data.type === 'custom') return data.name && /^planner\.[a-z0-9_.]+$/.test(data.name) ? data.name : 'planner.unknown';
    return `openai.agents.${/^[a-z0-9_]+$/.test(data.type) ? data.type : 'unknown'}`;
  };
  const safe = (work: () => void) => { try { work(); } catch { /* diagnostics never affects the agent */ } };
  return {
    async onTraceStart() {}, async onTraceEnd() {},
    async onSpanStart(span) { safe(() => {
      started.set(span.spanId, performance.now());
      capture.emit('span.started', { name: name(span.spanData), attributes: {} }, {
        spanId: id(span.spanId), parentSpanId: span.parentId ? id(span.parentId) : null,
      });
    }); },
    async onSpanEnd(span) { safe(() => {
      const start = started.get(span.spanId);
      capture.emit('span.finished', {
        name: name(span.spanData), attributes: {}, status: span.error ? 'error' : 'ok',
        outcome: span.error ? 'error' : 'ok', duration_ms: start === undefined ? 0 : Math.max(0, performance.now() - start), error: null,
      }, { spanId: id(span.spanId), parentSpanId: span.parentId ? id(span.parentId) : null });
      started.delete(span.spanId);
    }); },
    async forceFlush() {}, async shutdown() {},
  };
}

/** The CLI replaces the SDK exporter before any agent run. No trace leaves this process. */
export function installLocalDiagnostics(capture?: Capture): void {
  setTraceProcessors(capture ? [localProcessor(capture)] : []);
}

/** SDK context remains useful, while only allowlisted metadata reaches the shared writer. */
export function createPlannerTracing(capture?: Capture) {
  const traceId = capture ? `trace_${capture.runId.replaceAll('-', '')}` : undefined;
  const active = () => !!traceId && getCurrentTrace()?.traceId === traceId;
  const span = async <T>(name: string, _data: Record<string, unknown>, work: () => Promise<T>): Promise<T> => {
    if (!active()) return work();
    let called = false;
    let result: T | undefined;
    let failure: unknown;
    try {
      await withCustomSpan(async sdkSpan => {
        called = true;
        try { result = await work(); }
        catch (error) { failure = error; sdkSpan.setError({ message: 'operation failed' }); }
      }, { data: { name: /^planner\.[a-z0-9_.]+$/.test(name) ? name : 'planner.unknown', data: {} } });
    } catch { /* SDK tracing cannot suppress the work */ }
    if (!called) return work();
    if (failure !== undefined) throw failure;
    return result as T;
  };
  const tracing = {
    id: traceId,
    get enabled() { return !!capture && !/^(1|true)$/i.test(process.env.OPENAI_AGENTS_DISABLE_TRACING ?? ''); },
    bindRunId(_value?: string) {},
    async scope<T>(work: () => Promise<T>): Promise<T> {
      if (!tracing.enabled || active() || !traceId) return work();
      let called = false;
      let result: T | undefined;
      let failure: unknown;
      try { await withTrace('Integration planner', async () => { called = true; try { result = await work(); } catch (error) { failure = error; } }, { traceId, metadata: { host: 'openai-agents' } }); }
      catch { /* Preserve the original operation */ }
      if (!called) return work();
      if (failure !== undefined) throw failure;
      return result as T;
    },
    span,
    begin(name: string, _data: Record<string, unknown>): TraceInterval {
      if (!active()) return { end() {} };
      try {
        const sdkSpan = createCustomSpan({ data: { name: /^planner\.[a-z0-9_.]+$/.test(name) ? name : 'planner.unknown', data: {} } });
        sdkSpan.start();
        let ended = false;
        return { end(error) { if (ended) return; ended = true; try { if (error !== undefined) sdkSpan.setError({ message: 'operation failed' }); sdkSpan.end(); } catch { /* isolated */ } } };
      } catch { return { end() {} }; }
    },
    event(name: string, data: Record<string, unknown>) { tracing.begin(name.startsWith('planner.') ? name : `planner.${name}`, data).end(); },
    attempt(_request: ModelRequest, attempt: number, work: () => Promise<ModelResponse>) {
      return tracing.span('planner.provider_attempt', { attempt }, work);
    },
  };
  return tracing;
}
export type PlannerTracing = ReturnType<typeof createPlannerTracing>;
