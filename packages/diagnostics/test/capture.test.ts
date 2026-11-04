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
    const projected = projectError(outer, 'fetch');
    expect(projected.message).toBeNull();
    expect(projected.causes).toEqual([{ parent_index: -1, name: 'Error', code: 'ECONNRESET', message: null }]);
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('private');
  });
});
