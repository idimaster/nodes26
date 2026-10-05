import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDriver } from '../graph/connection.js';
import { writeRecording, type Call } from '../graph/replay/format.js';
import { decisions, expectations } from '../graph/replay/snapshot.js';
import { callsFromTranscript } from '../graph/replay/transcript.js';

/**
 * npm run record:session -- --transcript <session.jsonl> [--deal nimbus] [--out data/replays/nimbus-v1.jsonl]
 * Turns a live Claude Code planner session into a replay recording. Run it right after the session,
 * before anything resets the graph: the architect's decisions and the expected counts and verdicts are
 * read from the graph the session left behind. Transcripts live in ~/.claude/projects/<project>/.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

const transcript = opt('transcript');
const deal = opt('deal', 'nimbus');
const out = resolve(ROOT, opt('out', `data/replays/${deal}-v1.jsonl`));

const calls: Call[] = callsFromTranscript(readFileSync(transcript, 'utf8')).map((c, i) => ({ kind: 'call', seq: i + 1, ...c }));
if (calls.length === 0) throw new Error(`${transcript} has no state-changing planner calls`);
const driver = openDriver();
try {
  const header = { kind: 'header' as const, format: 1 as const, deal, source: 'live' as const, recorded_at: new Date().toISOString(), expect: await expectations(driver, deal) };
  const decided = await decisions(driver, deal);
  writeRecording(out, { header, calls, decisions: decided });
  console.log(`record: ${calls.length} calls and ${decided.length} decisions → ${out}. Check it with: npm run demo:replay -- ${out}`);
} finally {
  await driver.close();
}
