import {
  createCustomSpan, generateTraceId, getCurrentTrace, getGlobalTraceProvider, withCustomSpan, withTrace,
  BatchTraceProcessor, OpenAITracingExporter, setTraceProcessors,
  type ModelRequest, type ModelResponse, type TracingProcessor,
} from '@openai/agents';

type TraceData = Record<string, string | number | boolean>;
export interface TraceInterval { end(error?: unknown): void }

/** SDK 0.21 can include raw tool exceptions despite traceIncludeSensitiveData:false. */
export function redactTraceProcessor(processor: TracingProcessor, options: { deferShutdown?: boolean } = {}): TracingProcessor {
  const warn = () => console.error('trace processor failed; planner result is unchanged');
  return {
    start() { try { processor.start?.(); } catch { warn(); } },
    async onTraceStart(trace) {
      try {
        const copy = trace.clone();
        copy.metadata = Object.fromEntries(Object.entries(copy.metadata ?? {}).filter(([key]) => ['host', 'model', 'deal', 'node', 'undici'].includes(key)));
        await processor.onTraceStart(copy);
      } catch { warn(); }
    },
    async onTraceEnd(trace) { try { await processor.onTraceEnd(trace); } catch { warn(); } },
    async onSpanStart(_span) { /* export only completed, redacted spans */ },
    async onSpanEnd(span) {
      try {
        const copy = span.clone();
        const data = copy.spanData;
        if (data.type === 'function') { data.input = ''; data.output = ''; delete data.mcp_data; }
        if (data.type === 'response') { delete data._input; delete data._response; }
        if (data.type === 'generation') { delete data.input; delete data.output; delete data.model_config; }
        if (copy.error) {
          const safe = Object.fromEntries(Object.entries(copy.error.data ?? {}).filter(([key, value]) =>
            ['error_class', 'error_codes', 'status', 'request_id', 'transport_reason'].includes(key) && ['string', 'number'].includes(typeof value),
          ));
          copy.setError({ message: 'operation failed', data: safe });
        }
        await processor.onSpanEnd(copy);
      } catch { warn(); }
    },
    // The SDK signal handler may run before the CLI has closed its last spans/resources.
    // CLI-owned processors are drained explicitly afterward, without the provider's cached shutdown.
    shutdown: timeout => options.deferShutdown ? Promise.resolve() : processor.shutdown(timeout),
    forceFlush: () => processor.forceFlush(),
  };
}

/** Opt-in CLI owns its exporter; replace defaults so no unredacted parallel export route exists. */
let ownedProcessor: BatchTraceProcessor | undefined;
export function installPlannerTraceExporter(apiKey: string): void {
  // This exporter counts total attempts, unlike the model client's maxRetries setting.
  ownedProcessor = new BatchTraceProcessor(new OpenAITracingExporter({ apiKey, maxRetries: 1 }));
  setTraceProcessors([redactTraceProcessor(ownedProcessor, { deferShutdown: true })]);
}

/** Export classifications and identifiers, never raw exception messages or request payloads. */
function errorData(error: unknown): TraceData {
  const data: TraceData = {};
  const codes = new Set<string>();
  const pending = [error];
  const seen = new Set<object>();
  for (let n = 0; pending.length && n < 16; n++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Error) {
      if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)) data.error_class = value.name;
      if (value.message === 'fetch failed') data.transport_reason = 'fetch_failed';
      if (value.message === 'terminated') data.transport_reason = 'response_terminated';
      if (value instanceof AggregateError) pending.push(...value.errors.slice(0, 8));
    }
    if ('code' in value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) codes.add(value.code);
    if ('status' in value && typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) data.status = value.status;
    if ('requestID' in value && typeof value.requestID === 'string' && /^req_[a-zA-Z0-9_-]{1,128}$/.test(value.requestID)) data.request_id = value.requestID;
    if ('cause' in value) pending.push(value.cause);
  }
  if (codes.size) data.error_codes = [...codes].join(',');
  return data;
}

function bytes(value: unknown): number {
  try { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? ''); }
  catch { return 0; }
}

/** Instrumentation errors cannot re-execute the observed model/tool operation. */
async function observe<T>(work: () => Promise<T>, instrument: (call: () => Promise<void>, failure: () => { failed: boolean; error: unknown }) => Promise<unknown>, warn: () => void): Promise<T> {
  let called = false;
  let failed = false;
  let error: unknown;
  let result: T | undefined;
  const call = async () => {
    if (called) return;
    called = true;
    try { result = await work(); }
    catch (failure) { failed = true; error = failure; }
  };
  try { await instrument(call, () => ({ failed, error })); }
  catch { warn(); }
  if (!called) await call();
  if (failed) throw error;
  return result as T;
}

export function createPlannerTracing(options: { enabled: boolean; model: string; deal: string; warn?: (message: string) => void }) {
  let healthy = true;
  let runId: string | undefined;
  const id = options.enabled ? generateTraceId() : undefined;
  const metadata = { host: 'openai-agents', model: options.model, deal: options.deal, node: process.version, undici: process.versions.undici ?? 'unknown' };
  const warn = () => { healthy = false; (options.warn ?? console.error)('tracing unavailable; continuing planner without tracing'); };
  const active = () => options.enabled && healthy && getCurrentTrace()?.traceId === id;
  const spanData = (data: TraceData) => ({ ...(runId ? { run_id: runId } : {}), ...data });
  const tracing = {
    id,
    get enabled() { return options.enabled && healthy; },
    bindRunId(value?: string) { runId = value; },
    async scope<T>(work: () => Promise<T>): Promise<T> {
      if (!tracing.enabled || active() || !id) return work();
      return observe(work, call => withTrace('Integration planner', call, { traceId: id, metadata }), warn);
    },
    async span<T>(name: string, data: TraceData, work: () => Promise<T>): Promise<T> {
      if (!active()) return work();
      return observe(work, (call, failure) => withCustomSpan(async span => {
        await call();
        const outcome = failure();
        if (outcome.failed) span.setError({ message: 'operation failed', data: errorData(outcome.error) });
      }, { data: { name, data: spanData(data) } }), warn);
    },
    begin(name: string, data: TraceData): TraceInterval {
      if (!active()) return { end() { /* tracing is off */ } };
      try {
        const span = createCustomSpan({ data: { name, data: spanData(data) } });
        span.start();
        let ended = false;
        return { end(error) {
          if (ended) return;
          ended = true;
          try { if (error !== undefined) span.setError({ message: 'operation interrupted', data: errorData(error) }); span.end(); }
          catch { warn(); }
        } };
      } catch { warn(); return { end() { /* tracing failed */ } }; }
    },
    event(name: string, data: TraceData) { tracing.begin(name, data).end(); },
    async attempt(request: ModelRequest, attempt: number, work: () => Promise<ModelResponse>): Promise<ModelResponse> {
      if (!active()) return work();
      return tracing.span('provider.attempt', { attempt, input_bytes: bytes(request.input), instruction_bytes: bytes(request.systemInstructions), tool_count: request.tools.length }, async () => {
        const result = await work();
        const identifiers: TraceData = { attempt };
        if (result.requestId && /^req_[a-zA-Z0-9_-]{1,128}$/.test(result.requestId)) identifiers.request_id = result.requestId;
        tracing.event('provider.response', identifiers);
        return result;
      });
    },
  };
  return tracing;
}
export type PlannerTracing = ReturnType<typeof createPlannerTracing>;

/** SDK shutdown drains queued spans and aborts active exports at the same deadline. */
export async function flushPlannerTracing(shutdown?: (timeout: number) => Promise<void>): Promise<'flushed' | 'timeout' | 'failed'> {
  const processor = ownedProcessor;
  const drain = shutdown ?? (processor ? (timeout: number) => processor.shutdown(timeout) : (timeout: number) => getGlobalTraceProvider().shutdown(timeout));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 5000); });
    return await Promise.race([drain(5000).then(() => 'flushed' as const), deadline]);
  } catch { return 'failed'; }
  finally { clearTimeout(timer); if (ownedProcessor === processor && !shutdown) ownedProcessor = undefined; }
}
