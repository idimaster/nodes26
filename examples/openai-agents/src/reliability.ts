import { retryPolicies, type Model, type ModelRetrySettings } from '@openai/agents';
import type { PlannerTracing, TraceInterval } from './tracing.js';

export interface ProviderEvent {
  type: 'retry' | 'circuit_open' | 'circuit_probe' | 'circuit_closed' | 'circuit_failed';
  attempt: number;
  delayMs?: number;
  status?: number;
}
const ATTEMPTS = 4;
const COOLDOWN_MS = 30_000;
const SERVER_DELAY_CAP_MS = 60_000;
const TRANSIENT_CODES = new Set(['ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_STREAM_CANCEL', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'usage_limit_reached', 'account_deactivated']);

function failureInfo(error: unknown) {
  const codes = new Set<string>();
  const seen = new Set<object>();
  const pending = [error];
  let veto = false;
  let responseStarted = false;
  for (let n = 0; pending.length && n < 16; n++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if ('code' in value && typeof value.code === 'string') codes.add(value.code);
    if ('type' in value && typeof value.type === 'string') codes.add(value.type);
    if ('unsafeToReplay' in value && value.unsafeToReplay === true) veto = true;
    if ('responseStarted' in value && value.responseStarted === true) responseStarted = true;
    for (const key of ['headers', 'responseHeaders'] as const) {
      if (!(key in value)) continue;
      const headers = (value as Record<string, unknown>)[key];
      if (headers instanceof Headers) veto ||= headers.get('x-should-retry')?.toLowerCase() === 'false';
      else if (headers && typeof headers === 'object') veto ||= Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'x-should-retry' && value === 'false');
    }
    if ('cause' in value) pending.push(value.cause);
    if ('error' in value) pending.push(value.error);
    if (value instanceof AggregateError) pending.push(...value.errors.slice(0, 8));
  }
  const terminal = [...codes].some(code => QUOTA_CODES.has(code) || /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF)/.test(code)) ||
    (error instanceof Error && /insufficient[_ ]quota|exceeded your current quota|billing[_ ](?:hard|limit|not)/i.test(error.message));
  return { network: [...codes].some(code => TRANSIENT_CODES.has(code)), terminal, veto, responseStarted };
}

/** The Runner owns retry timing. This wrapper never has access to MCP execution. */
export function reliableModel(options: { model: Model; maxTurns: number; onEvent?: (event: ProviderEvent) => void; tracing?: PlannerTracing }) {
  let requests = 0;
  let failures = 0;
  let circuit: 'closed' | 'open' | 'probe' | 'failed' = 'closed';
  let waiting: TraceInterval | undefined;
  const endWaiting = (error?: unknown) => { waiting?.end(error); waiting = undefined; };
  const emit = (event: ProviderEvent) => {
    options.tracing?.event(`provider.${event.type}`, { attempt: event.attempt, ...(event.delayMs !== undefined ? { delay_ms: event.delayMs } : {}), ...(event.status !== undefined ? { status: event.status } : {}) });
    options.onEvent?.(event);
  };
  const basePolicy = retryPolicies.any(
    retryPolicies.providerSuggested(), retryPolicies.networkError(),
    retryPolicies.httpStatus([408, 409, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)]),
  );
  const model: Model = {
    async getResponse(request) {
      endWaiting(request.signal?.aborted ? request.signal.reason : undefined);
      request.signal?.throwIfAborted();
      if (circuit === 'failed') throw new Error('provider circuit is open after a failed probe');
      if (requests >= Math.min(Number.MAX_SAFE_INTEGER, options.maxTurns * ATTEMPTS)) throw new Error('provider attempt budget exhausted');
      if (circuit === 'open') { circuit = 'probe'; emit({ type: 'circuit_probe', attempt: requests + 1 }); }
      requests++;
      try {
        const work = () => options.model.getResponse(request);
        const response = await (options.tracing ? options.tracing.attempt(request, requests, work) : work());
        if (circuit === 'probe') emit({ type: 'circuit_closed', attempt: requests });
        failures = 0; circuit = 'closed';
        return response;
      } catch (error) {
        if (circuit === 'probe' && !request.signal?.aborted) {
          circuit = 'failed'; emit({ type: 'circuit_failed', attempt: requests });
          throw new Error(`provider circuit probe failed: ${error instanceof Error ? error.message : 'request failed'}`, { cause: error });
        }
        throw error;
      }
    },
    getStreamedResponse() { throw new Error('streaming is outside this adapter'); },
    async getRetryAdvice(args) {
      const advice = await options.model.getRetryAdvice?.(args);
      const info = failureInfo(args.error);
      return {
        ...advice,
        ...(info.responseStarted ? { responseStarted: true } : {}),
        ...(info.veto ? { suggested: false } : {}),
        normalized: { ...advice?.normalized, ...(info.network && advice?.normalized?.isNetworkError === undefined ? { isNetworkError: true } : {}) },
      };
    },
  };
  const retry: ModelRetrySettings = {
    maxRetries: ATTEMPTS - 1,
    backoff: { initialDelayMs: 1000, maxDelayMs: 8000, multiplier: 2, jitter: true },
    policy: async context => {
      const info = failureInfo(context.error);
      const { statusCode, retryAfterMs } = context.normalized;
      if (context.normalized.isAbort || context.stream || context.statefulRequest || context.replaySafety === 'unsafe' ||
        context.responseStarted || context.providerAdvice?.suggested === false || info.terminal || info.veto ||
        (statusCode !== undefined && ![408, 409, 429].includes(statusCode) && (statusCode < 500 || statusCode > 599))) {
        options.tracing?.event('provider.retry_stopped', { attempt: requests, reason: context.statefulRequest ? 'stateful_request' : context.replaySafety === 'unsafe' ? 'unsafe_replay' : context.responseStarted ? 'response_started' : context.providerAdvice?.suggested === false || info.veto ? 'provider_veto' : 'terminal_error', ...(statusCode !== undefined ? { status: statusCode } : {}) });
        return false;
      }
      const decision = await basePolicy(context);
      const resolved = typeof decision === 'boolean' ? { retry: decision } : decision;
      if (!resolved.retry) { options.tracing?.event('provider.retry_stopped', { attempt: requests, reason: 'not_retryable' }); return false; }
      const delayMs = resolved.delayMs ?? retryAfterMs;
      if (delayMs !== undefined && (!Number.isFinite(delayMs) || delayMs > SERVER_DELAY_CAP_MS)) throw new Error(`provider retry delay exceeds ${SERVER_DELAY_CAP_MS} ms; defer this run`);
      failures++;
      let cooldown = delayMs;
      if (failures >= ATTEMPTS - 1) {
        circuit = 'open'; cooldown = Math.max(COOLDOWN_MS, delayMs ?? 0);
        emit({ type: 'circuit_open', attempt: requests, delayMs: cooldown });
      }
      emit({ type: 'retry', attempt: requests + 1, ...(cooldown !== undefined ? { delayMs: cooldown } : {}), ...(statusCode !== undefined ? { status: statusCode } : {}) });
      waiting = options.tracing?.begin(circuit === 'open' ? 'provider.circuit_cooldown' : 'provider.backoff', { attempt: requests + 1, ...(cooldown !== undefined ? { delay_ms: cooldown } : {}) });
      return { ...resolved, ...(cooldown !== undefined ? { delayMs: cooldown } : {}) };
    },
  };
  return { model, retry, endWaiting, get requests() { return requests; } };
}
