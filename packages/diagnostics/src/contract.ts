import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaPath = fileURLToPath(new URL('../../../docs/design/diagnostics-v1.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

export interface DiagnosticRecord {
  format: 'planner.diagnostics'; version: 1; event: string; seq: number; event_id: string;
  time: string; elapsed_ms: number; run_id: string; trace_id: string; process_id: string;
  span_id: string | null; parent_span_id: string | null;
  context: { host: 'pi' | 'openai-agents'; deal: string | null; turn_id: string | null; invocation_id: string | null; http_attempt_id: string | null; tool_call_id: string | null };
  data: Record<string, unknown>;
}

export function validateRecord(value: unknown): value is DiagnosticRecord {
  return validate(value);
}

export function recordErrors(): string {
  return ajv.errorsText(validate.errors, { separator: '; ' });
}
