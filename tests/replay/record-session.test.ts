import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { readRecording } from '../../graph/replay/format.js';
import { replay } from '../../graph/replay/replay.js';

/**
 * T4.4: record-session.ts on a session transcript gives back the recording that produced the session.
 * The "live" session here is the golden replay, rendered as a Claude Code transcript.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
let driver: Driver;

beforeAll(() => {
  driver = openDriver();
});
afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('scripts/record-session.ts', () => {
  it('round-trips the golden run', async () => {
    const golden = readRecording(`${ROOT}data/replays/nimbus-v1.jsonl`);
    expect((await replay(golden, { driver, root: ROOT })).ok).toBe(true);

    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan the Nimbus integration.' } })];
    golden.calls.forEach((c, i) => {
      const id = `toolu_${i}`;
      // Gate servers send structuredContent, which Claude Code records as {result}.
      const text = JSON.stringify(c.server === 'gate' ? { result: c.result } : c.result);
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__${c.server}__${c.tool}`, input: c.args }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } }));
    });
    const dir = mkdtempSync(join(tmpdir(), 'record-'));
    writeFileSync(join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);

    const r = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/record-session.ts', '--transcript', join(dir, 'session.jsonl'), '--out', join(dir, 'out.jsonl')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const recorded = readRecording(join(dir, 'out.jsonl'));
    expect(recorded.header).toMatchObject({ source: 'live', deal: 'nimbus', expect: golden.header.expect });
    expect(recorded.calls).toEqual(golden.calls);
    expect(recorded.decisions).toEqual(golden.decisions);
  }, 120_000);
});
