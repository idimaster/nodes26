import { randomUUID } from 'node:crypto';

export type ErrorSource = 'fetch' | 'http_body' | 'provider_event' | 'stream_iterator' | 'pi_result' | 'host';
const codes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'FIXTURE_PARSE']);
const names = new Set(['Error', 'TypeError', 'AbortError', 'AggregateError', 'FetchError', 'APIError', 'FixtureParseError']);
const messages = new Set(['fetch failed', 'The operation was aborted', 'Fixture normalization failed after the terminal event.']);

/** An allowlisted projection: arbitrary provider/tool strings never enter the log. */
export function projectError(value: unknown, source: ErrorSource) {
  const get = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== 'object') return undefined;
    try { return (object as Record<string, unknown>)[key]; } catch { return undefined; }
  };
  const shape = (object: unknown) => {
    const rawName = get(object, 'name');
    const rawCode = get(object, 'code');
    const rawMessage = get(object, 'message');
    return {
      name: typeof rawName === 'string' && names.has(rawName) ? rawName : 'Error',
      code: typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : null,
      message: typeof rawMessage === 'string' && messages.has(rawMessage) ? rawMessage : null,
    };
  };
  const root = shape(value);
  const causes: { parent_index: number; name: string; code: string | null; message: string | null }[] = [];
  const seen = new Set<unknown>([value]);
  let truncated = false;
  const walk = (object: unknown, parent: number, depth: number) => {
    const children: unknown[] = [];
    const cause = get(object, 'cause');
    if (cause !== undefined) children.push(cause);
    const aggregate = get(object, 'errors');
    if (Array.isArray(aggregate)) children.push(...aggregate.slice(0, 9));
    for (const child of children) {
      if (seen.has(child) || depth >= 4 || causes.length >= 8) { truncated = true; continue; }
      seen.add(child);
      const index = causes.length;
      causes.push({ parent_index: parent, ...shape(child) });
      walk(child, index, depth + 1);
    }
    if (Array.isArray(aggregate) && aggregate.length > 9) truncated = true;
  };
  walk(value, -1, 1);
  return { id: randomUUID(), source, ...root, message_redacted: root.message === null, truncated, causes };
}
