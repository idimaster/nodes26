import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { GuardAudit } from './types.js';

export function auditLogger(root: string, env: NodeJS.ProcessEnv) {
  const path = resolve(root, env.GUARD_LOG ?? '.logs/guard.jsonl');
  return async (decision: GuardAudit) => {
    try { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(decision)}\n`); }
    catch { console.error('harness: guard audit log write failed'); }
  };
}
