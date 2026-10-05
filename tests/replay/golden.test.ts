import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { readRecording, type Recording } from '../../graph/replay/format.js';
import { replay, ReplayError } from '../../graph/replay/replay.js';

/** T4.4 golden run: on a fresh database, the replay reproduces the recorded counts and verdicts, with no LLM. */

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

describe.each(['nimbus-v1', 'nimbus-p4'])('replay of data/replays/%s.jsonl', (name) => {
  const rec = readRecording(`${ROOT}data/replays/${name}.jsonl`);

  it('reproduces the recorded counts and verdicts, with the same gate ids', async () => {
    const report = await replay(rec, { driver, root: ROOT });
    expect(report.differences).toEqual([]);
    expect(report).toMatchObject({ ok: true, calls: rec.calls.length });
  }, 120_000);
});

describe('replay fails loudly', () => {
  const golden = readRecording(`${ROOT}data/replays/nimbus-v1.jsonl`);

  it('when a recorded write would not pass the guard', async () => {
    const tampered: Recording = {
      ...golden,
      calls: [{ kind: 'call', seq: 1, server: 'neo4j-write', tool: 'write-cypher', args: { query: 'MATCH (n) DETACH DELETE n', params: {} }, result: [] }],
    };
    await expect(replay(tampered, { driver, root: ROOT })).rejects.toThrow(ReplayError);
    await expect(replay(tampered, { driver, root: ROOT })).rejects.toThrow(/call 1: the guard denied a recorded write: G2/);
  }, 60_000);

  it('when the result differs from the recording', async () => {
    const roadmaps = golden.header.expect.counts.Roadmap as number;
    const wrong: Recording = {
      ...golden,
      header: { ...golden.header, expect: { ...golden.header.expect, counts: { ...golden.header.expect.counts, Roadmap: roadmaps + 1 } } },
    };
    const report = await replay(wrong, { driver, root: ROOT });
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([`nodes Roadmap: expected ${roadmaps + 1}, got ${roadmaps}`]);
  }, 120_000);
});
