import { Agent, fetch as undiciFetch } from 'undici';

const RESET_CODES = new Set([
  'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_GOAWAY_SESSION',
]);

export interface ProviderTransport {
  fetch: typeof globalThis.fetch;
  rotate(): void;
  close(): Promise<void>;
}

/** Inspect only error codes; arbitrary error messages are not retry policy. */
export function shouldRotateProviderTransport(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    try {
      const value = current as { code?: unknown; cause?: unknown };
      if (typeof value.code === 'string' && RESET_CODES.has(value.code)) return true;
      current = value.cause;
    } catch { return false; }
  }
  return false;
}

/** Isolated provider pool: keep HTTP/2 session failures away from the planner's other clients. */
export function createProviderTransport(): ProviderTransport {
  const newAgent = () => new Agent({ allowH2: false });
  let agent = newAgent();
  let closed = false;
  let cleanupError: unknown;
  let closing: Promise<void> | undefined;
  const retired = new Set<Promise<void>>();
  return {
    fetch(input, init) {
      if (closed) throw new Error('provider transport is closed');
      // Pair the dispatcher with the same Undici package; Node's bundled fetch
      // can carry a different Dispatcher type and implementation version.
      return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...init, dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    },
    rotate() {
      if (closed) return;
      const old = agent;
      agent = newAgent();
      const pending = old.close().catch(error => { cleanupError ??= error; });
      retired.add(pending);
      void pending.finally(() => retired.delete(pending));
    },
    close() {
      closing ??= (async () => {
        closed = true;
        const results = await Promise.allSettled([agent.close(), ...retired]);
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        if (cleanupError) throw cleanupError;
      })();
      return closing;
    },
  };
}
