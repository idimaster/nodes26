import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { setTracingDisabled } from '@openai/agents';
import { createCapture, readCapture } from '../../packages/diagnostics/src/index.js';
import { createPlannerTracing, installLocalDiagnostics } from '../../examples/openai-agents/src/local-tracing.js';

it('writes SDK spans locally without prompt or tool payloads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openai-agent-diagnostics-'));
  const capture = createCapture({ root, deal: 'nimbus', host: 'openai-agents', model: 'test-model' })!;
  installLocalDiagnostics(capture);
  setTracingDisabled(false);
  const tracing = createPlannerTracing(capture);
  await tracing.scope(() => tracing.span('planner.run', { prompt: 'PRIVATE_PROMPT' }, async () => 'ok'));
  setTracingDisabled(true);
  capture.finish({ outcome: 'completed' });
  const read = await readCapture(capture.path);
  expect(read.valid).toBe(true);
  expect(read.complete).toBe(true);
  expect(read.records.some(record => record.event === 'span.started')).toBe(true);
  expect(readFileSync(capture.path, 'utf8')).not.toContain('PRIVATE_PROMPT');
  expect(readFileSync(capture.path, 'utf8')).not.toContain('traces/ingest');
});

it('disables SDK capture without a file', async () => {
  installLocalDiagnostics();
  const tracing = createPlannerTracing();
  expect(await tracing.scope(async () => 'ok')).toBe('ok');
  expect(tracing.enabled).toBe(false);
});
