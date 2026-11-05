import { randomUUID } from 'node:crypto';

export type ErrorSource = 'fetch' | 'http_body' | 'provider_event' | 'stream_iterator' | 'pi_result' | 'host';
const codeToken = /^(?!sk[-_])[A-Za-z][A-Za-z0-9._-]{0,127}$/i;
const names = new Set([
  'Error', 'TypeError', 'AbortError', 'AggregateError', 'FetchError', 'APIError',
  'SocketError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError',
  'RequestAbortedError', 'FixtureParseError',
]);
const messages = new Set(['fetch failed', 'The operation was aborted', 'Fixture normalization failed after the terminal event.']);
const syscalls = new Set(['connect', 'getaddrinfo', 'read', 'write', 'lookup', 'send', 'recv']);

/** A bounded projection: error codes are retained as identifiers, never free-form text. */
export function projectError(value: unknown, source: ErrorSource) {
  const fetchDetail = source === 'fetch';
  let truncated = false;
  const get = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== 'object') return undefined;
    try { return (object as Record<string, unknown>)[key]; } catch { return undefined; }
  };
  const shape = (object: unknown) => {
    const rawName = get(object, 'name');
    const rawCode = get(object, 'code');
    const rawMessage = get(object, 'message');
    const rawErrno = get(object, 'errno');
    const rawSyscall = get(object, 'syscall');
    const code = fetchDetail
      ? typeof rawCode === 'string' && rawCode.length > 0 && rawCode.length <= 512 ? rawCode
        : typeof rawCode === 'number' && Number.isFinite(rawCode) ? String(rawCode) : null
      : typeof rawCode === 'string' && codeToken.test(rawCode) ? rawCode : null;
    const codeKind = rawCode === undefined || rawCode === null ? 'absent'
      : typeof rawCode === 'number' ? 'numeric'
      : typeof rawCode !== 'string' ? 'other'
      : rawCode.startsWith('UND_ERR_') ? 'undici'
      : rawCode.startsWith('ERR_') ? 'node'
      : /^E[A-Z0-9_]+$/.test(rawCode) ? 'system' : 'other';
    const name = fetchDetail && typeof rawName === 'string' && rawName.length > 0 && rawName.length <= 128
      ? rawName : typeof rawName === 'string' && names.has(rawName) ? rawName : 'Error';
    const message = fetchDetail && typeof rawMessage === 'string' && rawMessage.length > 0 && rawMessage.length <= 2048
      ? rawMessage : !fetchDetail && typeof rawMessage === 'string' && messages.has(rawMessage) ? rawMessage : null;
    if (fetchDetail && ((typeof rawCode === 'string' && rawCode.length > 512)
      || (typeof rawMessage === 'string' && rawMessage.length > 2048)
      || (typeof rawName === 'string' && rawName.length > 128))) truncated = true;
    return {
      name,
      code,
      code_availability: code ? 'observed' as const : rawCode === undefined || rawCode === null ? 'absent' as const : 'rejected' as const,
      code_kind: codeKind,
      errno: typeof rawErrno === 'number' && Number.isInteger(rawErrno) && rawErrno >= -2147483648 && rawErrno <= 2147483647 ? rawErrno : null,
      syscall: typeof rawSyscall === 'string' && syscalls.has(rawSyscall) ? rawSyscall : null,
      message,
    };
  };
  const root = shape(value);
  const causes: { parent_index: number; name: string; code: string | null; code_availability: 'observed' | 'absent' | 'rejected'; code_kind: string; errno: number | null; syscall: string | null; message: string | null }[] = [];
  const seen = new Set<unknown>([value]);
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
