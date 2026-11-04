import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import pino from 'pino';
import { projectError, type ErrorSource } from './sanitize.js';
import { recordErrors, validateRecord, type DiagnosticRecord } from './contract.js';

const FILE_CAP = 32 * 1024 * 1024;
const LINE_CAP = 32 * 1024;
type Context = DiagnosticRecord['context'];

export interface Capture {
  readonly runId: string;
  readonly path: string;
  readonly relativePath: string;
  readonly degraded: boolean;
  readonly count: number;
  emit(event: string, data: Record<string, unknown>, options?: { spanId?: string | null; parentSpanId?: string | null; context?: Partial<Context> }): void;
  error(value: unknown, source: ErrorSource): string;
  finish(options: { outcome: 'completed' | 'failed' | 'cancelled'; reasonCode?: string | null; providerAttempts?: number; httpAttempts?: number; cleanupErrors?: number; generationOutcome?: 'completed' | 'failed' | 'incomplete' | 'unknown'; clientOutcome?: 'completed' | 'failed' | 'cancelled' | 'unknown'; graphOutcome?: 'committed' | 'not_committed' | 'partial' | 'unknown' }): void;
}

export function createCapture(options: { root: string; deal: string | null; provider?: string | null; model?: string | null; endpoint?: { scheme: string; hostname: string; port: number | null; path: string } | null; runId?: string; policy?: 'metadata' | 'off'; warn?: (message: string) => void }): Capture | undefined {
  if (options.policy === 'off') return undefined;
  const runId = options.runId ?? randomUUID();
  const processId = randomUUID();
  const path = join(options.root, '.logs', 'diagnostics', `${runId}.jsonl`);
  mkdirSync(join(options.root, '.logs', 'diagnostics'), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  if (!statSync(path).isFile()) { closeSync(fd); throw new Error('diagnostics target is not a regular file'); }
  const destination = pino.destination({ dest: fd, sync: true });
  const warn = options.warn ?? (message => console.error(message));
  const start = process.hrtime.bigint();
  let seq = 0;
  let bytes = 0;
  let closed = false;
  let degraded = false;
  let dropped = 0;
  let warned = false;
  const warning = (reason: string) => { degraded = true; if (!warned) { warned = true; try { warn(`diagnostics capture degraded: ${reason}`); } catch { /* diagnostics cannot change application control flow */ } } };
  destination.on('error', () => warning('write failed'));
  const context: Context = { host: 'pi', deal: options.deal, turn_id: null, invocation_id: null, http_attempt_id: null, tool_call_id: null };
  const emit: Capture['emit'] = (event, data, extra = {}) => {
    if (closed || degraded) { dropped++; return; }
    const next = seq + 1;
    const record: DiagnosticRecord = {
      format: 'planner.diagnostics', version: 1, event, seq: next, event_id: `${processId}:${next}`,
      time: new Date().toISOString(), elapsed_ms: Number(process.hrtime.bigint() - start) / 1e6,
      run_id: runId, trace_id: runId.replaceAll('-', ''), process_id: processId,
      span_id: extra.spanId ?? null, parent_span_id: extra.parentSpanId ?? null,
      context: { ...context, ...extra.context }, data,
    };
    if (!validateRecord(record)) { dropped++; warning(`invalid ${event} projection: ${recordErrors()}`); return; }
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line);
    if (length > LINE_CAP || bytes + length > FILE_CAP - 4096) { dropped++; warning('size limit'); return; }
    try { destination.write(line); seq = next; bytes += length; }
    catch { dropped++; warning('write failed'); }
  };
  const capture: Capture = {
    runId, path, relativePath: relative(options.root, path),
    get degraded() { return degraded; }, get count() { return seq; }, emit,
    error(value, source) {
      const error = projectError(value, source);
      const phase = source === 'http_body' ? 'http_error_body' : source === 'provider_event' || source === 'stream_iterator' ? 'stream' : source === 'pi_result' ? 'normalize' : source === 'host' ? 'prepare' : 'fetch';
      emit('provider.failed', { phase, error, http_status: null, request_id: null, response_id: null, last_event_type: null, raw_completed_seen: false });
      return error.id;
    },
    finish(result) {
      if (closed) return;
      emit('run.finished', {
        outcome_scope: { turn_id: null, invocation_id: null, selection: 'not_observed' },
        outcome: result.outcome, reason_code: result.reasonCode ?? null,
        generation_outcome: result.generationOutcome ?? 'unknown', client_outcome: result.clientOutcome ?? 'unknown',
        graph_outcome: result.graphOutcome ?? 'unknown', provider_attempts: result.providerAttempts ?? 0,
        http_attempts: result.httpAttempts ?? 0, cleanup_error_count: result.cleanupErrors ?? 0,
        capture_degraded: degraded,
      });
      emit('capture.summary', { record_count_before_summary: seq, dropped_records: dropped, redacted_fields: 0, truncated_fields: 0, unfinished_span_count: 0, degraded, reason: degraded ? 'capture_failed' : null });
      try { destination.flushSync(); destination.end(); } catch { warning('close failed'); }
      closed = true;
    },
  };
  emit('run.started', {
    capture_policy: 'metadata', node_version: process.versions.node, platform: process.platform, arch: process.arch,
    versions: { pi_agent_core: '1.5.0', pi_ai: '1.5.0', pi_telemetry: '1.5.0', pino: '10.4.0' },
    release_sha: null, provider: options.provider ?? null, model: options.model ?? null, endpoint: options.endpoint ?? null,
  });
  return capture;
}

export function newSpanId(): string { return randomBytes(8).toString('hex'); }
