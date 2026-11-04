import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { validateRecord, recordErrors, type DiagnosticRecord } from './contract.js';

const FILE_CAP = 32 * 1024 * 1024;
const LINE_CAP = 32 * 1024;

export interface CaptureRead {
  valid: boolean;
  complete: boolean;
  partial: boolean;
  problems: string[];
  records: DiagnosticRecord[];
  bytes: number;
  sha256: string;
}

export async function readCapture(path: string): Promise<CaptureRead> {
  const info = await stat(path);
  if (!info.isFile() || info.size > FILE_CAP) throw new Error('diagnostics input must be a regular file of at most 32 MiB');
  const records: DiagnosticRecord[] = [];
  const problems: string[] = [];
  const hash = createHash('sha256');
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let invalid = false;
  const takeLine = (line: Buffer) => {
    if (line.length > LINE_CAP) throw new Error('diagnostics line exceeds 32 KiB');
    if (!line.length) { invalid = true; problems.push('empty terminated line'); return; }
    try {
      const value: unknown = JSON.parse(line.toString('utf8'));
      if (!validateRecord(value)) { invalid = true; problems.push(`invalid record: ${recordErrors()}`); return; }
      if (records.length >= 100_000) throw new Error('diagnostics record limit exceeded');
      records.push(value);
    } catch (error) {
      if (error instanceof SyntaxError) { invalid = true; problems.push('malformed terminated line'); }
      else throw error;
    }
  };
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > FILE_CAP) throw new Error('diagnostics input grew beyond 32 MiB');
    hash.update(buffer);
    pending = Buffer.concat([pending, buffer]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      takeLine(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > LINE_CAP) throw new Error('diagnostics line exceeds 32 KiB');
  }
  if (pending.length) problems.push('unterminated final line');
  const first = records[0];
  if (!first || first.event !== 'run.started' || first.seq !== 1) { invalid = true; problems.push('missing first run.started'); }
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.seq !== index + 1 || record.event_id !== `${record.process_id}:${record.seq}`) { invalid = true; problems.push(`sequence mismatch at ${index + 1}`); }
    if (first && (record.run_id !== first.run_id || record.trace_id !== first.trace_id || record.process_id !== first.process_id || record.context.deal !== first.context.deal)) { invalid = true; problems.push(`mixed identity at ${index + 1}`); }
    if (record.trace_id !== record.run_id.replaceAll('-', '')) { invalid = true; problems.push(`trace mismatch at ${index + 1}`); }
    if (record.event === 'span.started' && record.span_id) {
      if (started.has(record.span_id)) { invalid = true; problems.push(`duplicate span at ${index + 1}`); }
      started.add(record.span_id);
      if (started.size > 10_000) throw new Error('diagnostics span limit exceeded');
    }
    if (record.event === 'span.finished' && record.span_id) {
      if (!started.has(record.span_id) || finished.has(record.span_id)) { invalid = true; problems.push(`invalid span settlement at ${index + 1}`); }
      finished.add(record.span_id);
    }
  }
  if (started.size !== finished.size) problems.push(`${started.size - finished.size} unfinished span(s)`);
  const complete = !invalid && !pending.length && records.at(-1)?.event === 'capture.summary' && !records.at(-1)?.data.degraded && started.size === finished.size;
  return { valid: !invalid, complete, partial: !complete, problems, records, bytes, sha256: hash.digest('hex') };
}
