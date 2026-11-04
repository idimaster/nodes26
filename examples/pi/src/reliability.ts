import type { StreamFn } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import { projectError, type Capture } from '@planner/diagnostics';
import {
  createAssistantMessageEventStream, isRetryableAssistantError, retryAssistantCall,
  type Api, type AssistantMessage, type Model,
} from '@earendil-works/pi-ai';

const TURN_ATTEMPTS = 4;
const HTTP_RETRIES = 2;
const SERVER_DELAY_CAP_MS = 60_000;
const CIRCUIT_FAILURES = 3;
const COOLDOWN_MS = 30_000;

function waitForCooldown(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ProviderStatus {
  type: 'retry' | 'circuit_open' | 'circuit_probe' | 'circuit_closed';
  provider: string;
  attempt: number;
  kind?: 'transport' | 'response';
  delayMs?: number;
}

const DIAGNOSTIC_HEADERS = [
  'x-request-id', 'retry-after', 'retry-after-ms',
  'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-project-tokens', 'x-ratelimit-remaining-project-tokens',
] as const;
function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value && value.length <= 256 && /^[!-~]+$/.test(value) ? value : null;
}
function endpointOf(input: Parameters<typeof globalThis.fetch>[0]) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname.length > 128) return null;
    return { scheme: url.protocol.slice(0, -1), hostname: url.hostname, port: url.port ? Number(url.port) : null, path: url.pathname };
  } catch { return null; }
}

function failureMessage(model: Model<Api>, message: string, aborted = false): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? 'aborted' : 'error', errorMessage: message, timestamp: Date.now(),
  };
}

/** Retry only a provider response. This layer has no reference to tools or the gateway. */
export function createReliableStream(options: {
  streamFn: StreamFn; maxRequests: number; signal?: AbortSignal;
  fetch?: typeof globalThis.fetch; onStatus?: (event: ProviderStatus) => void; capture?: Capture;
}) {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) throw new Error('maxRequests must be a positive integer');
  let requests = 0;
  let httpAttempts = 0;
  let failures = 0;
  let circuit: 'closed' | 'open' | 'probe' = 'closed';
  let openUntil = 0;
  let providerUntil = 0;
  let terminal: string | undefined;

  const streamFn: StreamFn = (model, context, streamOptions) => {
    const output = createAssistantMessageEventStream();
    const signals = [streamOptions?.signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);
    let turnAttempts = 0;
    let active: AbortController | undefined;
    const emit = (type: ProviderStatus['type'], extra: Partial<ProviderStatus> = {}) => options.onStatus?.({ type, provider: model.provider, attempt: turnAttempts, ...extra });
    const stop = (reason: string): never => {
      terminal ??= reason;
      active?.abort();
      throw new Error(terminal);
    };
    const check = () => {
      signal.throwIfAborted();
      if (terminal) stop(terminal);
      if (requests >= options.maxRequests) stop(`provider request budget exhausted (${options.maxRequests}); plan is incomplete`);
      if (turnAttempts >= TURN_ATTEMPTS) stop(`provider turn attempt limit exhausted (${TURN_ATTEMPTS}); plan is incomplete`);
    };
    const reserve = async () => {
      check();
      const wait = Math.max(0, providerUntil - Date.now(), circuit === 'open' ? openUntil - Date.now() : 0);
      if (wait > 0) await waitForCooldown(wait, signal);
      check();
      if (circuit === 'open') { circuit = 'probe'; emit('circuit_probe', { attempt: turnAttempts + 1 }); }
      requests++; turnAttempts++;
    };
    const failed = () => {
      if (signal.aborted || terminal) return;
      failures++;
      if (circuit === 'probe') stop('provider circuit probe failed; plan is incomplete');
      if (failures >= CIRCUIT_FAILURES && circuit === 'closed') {
        circuit = 'open'; openUntil = Date.now() + COOLDOWN_MS;
        emit('circuit_open', { delayMs: COOLDOWN_MS });
      }
    };

    const produce = async (): Promise<AssistantMessage> => {
      active = new AbortController();
      const callSignal = AbortSignal.any([signal, active.signal]);
      let firstFetch = true;
      let lastFetchFailed = false;
      try {
        await reserve(); // Also counts synthetic/no-fetch provider attempts in deterministic tests.
        const fetch = options.fetch ?? streamOptions?.fetch ?? globalThis.fetch;
        const guardedFetch: typeof globalThis.fetch = async (input, init) => {
          callSignal.throwIfAborted();
          if (!firstFetch) { await reserve(); emit('retry', { kind: 'transport' }); }
          firstFetch = false;
          const fetchSignal = init?.signal ? AbortSignal.any([callSignal, init.signal]) : callSignal;
          const httpAttemptId = randomUUID();
          const clientRequestId = randomUUID();
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (!headers.has('X-Client-Request-Id') && options.capture) headers.set('X-Client-Request-Id', clientRequestId);
          const sentClientRequestId = headers.get('X-Client-Request-Id') ?? clientRequestId;
          const endpoint = endpointOf(input);
          const bodyBytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : init?.body instanceof Uint8Array ? init.body.byteLength : null;
          httpAttempts++;
          if (options.capture && endpoint) options.capture.emit('provider.http.started', {
            client_request_id: sentClientRequestId, endpoint, turn_attempt_index: turnAttempts,
            budget_attempt_index: requests, http_attempt_index: httpAttempts, body_bytes: bodyBytes,
          }, { context: { http_attempt_id: httpAttemptId } });
          const started = performance.now();
          let response: Response;
          try { response = await fetch(input, { ...init, ...(options.capture ? { headers } : {}), signal: fetchSignal }); }
          catch (error) {
            options.capture?.emit('provider.failed', { phase: 'fetch', error: projectError(error, 'fetch'), http_status: null, request_id: null, response_id: null, last_event_type: null, raw_completed_seen: false }, { context: { http_attempt_id: httpAttemptId } });
            if (!callSignal.aborted && !terminal) { lastFetchFailed = true; failed(); }
            throw error;
          }
          options.capture?.emit('provider.http.received', {
            status: response.status, headers_ms: Math.max(0, performance.now() - started), request_id: headerValue(response.headers, 'x-request-id'),
            headers: Object.fromEntries(DIAGNOSTIC_HEADERS.map(name => [name, headerValue(response.headers, name)])),
          }, { context: { http_attempt_id: httpAttemptId } });
          lastFetchFailed = false;
          if (!response.ok) {
            // The SDK handles HTTP statuses, backoff/jitter and Retry-After. Inspect only errors
            // to stop quota/auth failures immediately and preserve a final Retry-After across
            // assistant-level retries. Bodies/headers are never included in status events.
            const retryableStatus = [408, 409, 429].includes(response.status) || response.status >= 500;
            if (!retryableStatus) stop(`provider request failed (HTTP ${response.status}); request is not retryable`);
            if (response.headers.get('x-should-retry') === 'false') stop(`provider refused retry (HTTP ${response.status})`);
            const retryMs = response.headers.get('retry-after-ms');
            const retryAfter = response.headers.get('retry-after');
            let wait = retryMs === null ? NaN : Number.parseFloat(retryMs);
            if (!Number.isFinite(wait) && retryAfter !== null) {
              const seconds = Number.parseFloat(retryAfter);
              wait = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
            }
            if (Number.isFinite(wait)) {
              if (wait > SERVER_DELAY_CAP_MS) stop(`provider requested retry delay above ${SERVER_DELAY_CAP_MS} ms; plan is incomplete`);
              providerUntil = Math.max(providerUntil, Date.now() + Math.max(0, wait));
            }
            let text: string;
            try { text = await response.clone().text(); }
            catch (error) {
              options.capture?.emit('provider.failed', { phase: 'http_error_body', error: projectError(error, 'http_body'), http_status: response.status, request_id: headerValue(response.headers, 'x-request-id'), response_id: null, last_event_type: null, raw_completed_seen: false }, { context: { http_attempt_id: httpAttemptId } });
              if (!callSignal.aborted && !terminal) { lastFetchFailed = true; failed(); }
              throw error;
            }
            if (!isRetryableAssistantError(failureMessage(model, `server error ${response.status} ${text}`))) {
              stop(`provider request failed (HTTP ${response.status}); ${response.status === 429 ? 'quota/billing limit' : 'request is not retryable'}`);
            }
            lastFetchFailed = true; failed();
          }
          return response;
        };
        const source = await options.streamFn(model, context, {
          ...streamOptions, signal: callSignal, fetch: guardedFetch,
          maxRetries: HTTP_RETRIES, maxRetryDelayMs: SERVER_DELAY_CAP_MS,
        });
        // Drain without exposing failed fragments to the agent or retaining a full event buffer.
        for await (const event of source) { void event; }
        let message = await source.result();
        if (terminal) return failureMessage(model, terminal, true); // Stop retryAssistantCall too.
        if (signal.aborted) return failureMessage(model, 'run aborted', true);
        // The HTTP helper also retries statuses (408/409) absent from the assistant text
        // classifier. Preserve our verified transient classification across the SDK boundary.
        if (message.stopReason === 'error' && lastFetchFailed && !isRetryableAssistantError(message)) {
          message = { ...message, errorMessage: `Transient provider server error: ${message.errorMessage ?? 'request failed'}` };
        }
        if (isRetryableAssistantError(message) && !lastFetchFailed) failed();
        if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
          if (circuit !== 'closed') emit('circuit_closed');
          failures = 0; circuit = 'closed'; providerUntil = 0;
        }
        return message;
      } catch (error) {
        if (terminal) return failureMessage(model, terminal, true);
        if (signal.aborted) return failureMessage(model, 'run aborted', true);
        const message = failureMessage(model, error instanceof Error ? error.message : String(error));
        if (isRetryableAssistantError(message) && !lastFetchFailed) {
          try { failed(); } catch { return failureMessage(model, terminal ?? 'provider circuit probe failed', true); }
        }
        return message;
      }
    };

    void (async () => {
      let message: AssistantMessage;
      try {
        message = await retryAssistantCall(produce, { enabled: true, maxRetries: TURN_ATTEMPTS - 1, baseDelayMs: 1000, maxAgentDelayMs: 4000 }, signal, {
          onRetryScheduled: (_attempt, _max, delayMs) => { emit('retry', { kind: 'response', attempt: turnAttempts + 1, delayMs }); },
        });
        if (signal.aborted) message = failureMessage(model, 'run aborted', true);
        else if (terminal) message = failureMessage(model, terminal);
      } catch (error) {
        message = failureMessage(model, terminal ?? (error instanceof Error ? error.message : String(error)), signal.aborted);
      }
      if (message.stopReason === 'pending') {
        message = failureMessage(model, 'provider returned a response without a terminal event');
        output.push({ type: 'error', reason: 'error', error: message });
      } else if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        const reason = message.stopReason;
        message = { ...message, content: [] };
        output.push({ type: 'error', reason, error: message });
      } else {
        output.push({ type: 'start', partial: message });
        for (const [contentIndex, content] of message.content.entries()) {
          if (content.type === 'text') output.push({ type: 'text_delta', contentIndex, delta: content.text, partial: message });
        }
        output.push({ type: 'done', reason: message.stopReason, message });
      }
      output.end(message);
    })();
    return output;
  };
  return { streamFn, get requests() { return requests; }, get httpAttempts() { return httpAttempts; } };
}
