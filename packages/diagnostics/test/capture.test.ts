import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCapture, projectError, readCapture } from '../src/index.js';

describe('local diagnostics capture', () => {
  it('writes schema-valid, ordered records to a private per-run file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-diagnostics-'));
    const capture = createCapture({ root, deal: 'nimbus', provider: 'openai', model: 'gpt-5' });
    expect(capture).toBeDefined();
    capture!.finish({ outcome: 'failed', reasonCode: 'startup_failed' });
    const parsed = await readCapture(capture!.path);
    expect(parsed.valid).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.records.map(record => record.event)).toEqual(['run.started', 'run.finished', 'capture.summary']);
    expect(parsed.records.map(record => record.seq)).toEqual([1, 2, 3]);
    expect(readFileSync(capture!.path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('rejects mixed identities and a malformed terminated record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-diagnostics-'));
    const capture = createCapture({ root, deal: 'nimbus' })!;
    capture.finish({ outcome: 'failed', reasonCode: 'startup_failed' });
    const lines = readFileSync(capture.path, 'utf8').trimEnd().split('\n');
    const changed = JSON.parse(lines[1]!) as Record<string, unknown>;
    changed.run_id = '11111111-1111-4111-8111-111111111111';
    lines[1] = JSON.stringify(changed);
    writeFileSync(capture.path, `${lines.join('\n')}\n`);
    expect((await readCapture(capture.path)).valid).toBe(false);
    writeFileSync(capture.path, `${lines[0]}\n{bad json}\n`);
    expect((await readCapture(capture.path)).valid).toBe(false);
  });

  it('leaves unknown error messages out of the capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-diagnostics-'));
    const capture = createCapture({ root, deal: 'nimbus' })!;
    capture.error(new Error('secret prompt and /Users/example/private.txt'), 'host');
    capture.finish({ outcome: 'failed', reasonCode: 'startup_failed' });
    expect(readFileSync(capture.path, 'utf8')).not.toContain('secret prompt');
    expect(readFileSync(capture.path, 'utf8')).not.toContain('/Users/example');
    expect(readFileSync(capture.path, 'utf8')).toContain('provider.failed');
  });

  it('creates no file when capture is off', () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-diagnostics-'));
    expect(createCapture({ root, deal: 'nimbus', policy: 'off' })).toBeUndefined();
  });

  it('projects nested causes without leaking unknown text or looping on cycles', () => {
    const inner = Object.assign(new Error('private provider text'), { code: 'ECONNRESET' });
    const outer = Object.assign(new Error('private prompt'), { cause: inner });
    Object.assign(inner, { cause: outer });
    const projected = projectError(outer, 'host');
    expect(projected.message).toBeNull();
    expect(projected.causes).toEqual([{ parent_index: -1, name: 'Error', code: 'ECONNRESET', code_availability: 'observed', code_kind: 'system', errno: null, syscall: null, message: null }]);
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('private');
  });

  it('keeps fetch cause details, while retaining bounded fields', () => {
    const cause = Object.assign(new Error('connection to private.example failed'), { code: 'ENETUNREACH', errno: -51, syscall: 'connect', address: 'private.example' });
    const result = projectError(Object.assign(new TypeError('fetch failed'), { cause }), 'fetch');
    expect(result.causes[0]).toMatchObject({ code: 'ENETUNREACH', code_availability: 'observed', errno: -51, syscall: 'connect', message: 'connection to private.example failed' });
    expect(result).not.toHaveProperty('address');
    const rejected = projectError(Object.assign(new Error('private'), { code: 'secret prompt value' }), 'fetch');
    expect(rejected).toMatchObject({ code: 'secret prompt value', code_availability: 'observed', code_kind: 'other', message: 'private' });
  });

  it('retains unfamiliar fetch codes including ones previously rejected by token syntax', () => {
    for (const code of ['UND_ERR_REQ_RETRY', 'UND_ERR_FUTURE_FAILURE', 'EPROTO', 'ERR_UNKNOWN_TRANSPORT_STATE', 'provider.error_42']) {
      const cause = Object.assign(new Error('untrusted detail'), { code });
      expect(projectError(new TypeError('fetch failed', { cause }), 'fetch').causes[0]).toMatchObject({ code, code_availability: 'observed', message: 'untrusted detail' });
    }
    for (const code of ['ERR_HTTP2_INVALID_SESSION: session closed', 'ERR_BAD\nSTATE', 'x'.repeat(129)]) {
      const cause = Object.assign(new Error('untrusted detail'), { code });
      const projected = projectError(new TypeError('fetch failed', { cause }), 'fetch');
      expect(projected.causes[0]).toMatchObject({ code, code_availability: 'observed' });
    }
    const overlong = projectError(Object.assign(new Error('private'), { code: 'x'.repeat(513), message: 'm'.repeat(2049) }), 'fetch');
    expect(overlong).toMatchObject({ code: null, code_availability: 'rejected', message: null, message_redacted: true, truncated: true });
  });

  it('persists an unusual fetch code and message in a schema-valid capture', async () => {
    const capture = createCapture({ root: mkdtempSync(join(tmpdir(), 'planner-code-')), deal: 'nimbus' })!;
    const cause = Object.assign(new Error('The session has been destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION: stale session' });
    const error = projectError(new TypeError('fetch failed', { cause }), 'fetch');
    capture.emit('provider.failed', { phase: 'fetch', error, http_status: null, request_id: null, response_id: null, last_event_type: null, raw_completed_seen: false });
    capture.finish({ outcome: 'failed', reasonCode: 'run_incomplete' });
    const read = await readCapture(capture.path);
    expect(read.valid).toBe(true);
    expect(read.records.find(r => r.event === 'provider.failed')?.data.error).toMatchObject({ causes: [expect.objectContaining({ code: 'ERR_HTTP2_INVALID_SESSION: stale session', message: 'The session has been destroyed' })] });
    expect(readFileSync(capture.path, 'utf8')).toContain('The session has been destroyed');
  });

  it('retains safe projection for non-fetch errors', () => {
    const projected = projectError(Object.assign(new Error('private prompt'), { code: 'secret prompt value' }), 'host');
    expect(projected).toMatchObject({ name: 'Error', code: null, code_availability: 'rejected', message: null });
  });
});
