import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDriver } from '../graph/connection.js';
import { readRecording } from '../graph/replay/format.js';
import { replay } from '../graph/replay/replay.js';

/**
 * npm run demo:replay [-- <recording.jsonl>] [--delay <ms>]
 * Tier 0: wipes the graph, reloads the demo data, and re-executes a recorded planner run with no LLM.
 * Open the demo UI (npm run demo:ui) first and use --delay to watch it build.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const delayAt = args.indexOf('--delay');
const delayMs = delayAt >= 0 ? Number(args[delayAt + 1]) : 0;
const file = resolve(ROOT, args.find((a, i) => !a.startsWith('--') && i !== delayAt + 1) ?? 'data/replays/nimbus-v1.jsonl');

const rec = readRecording(file);
console.log(`replay: ${file} (${rec.header.source}, deal ${rec.header.deal}, ${rec.calls.length} calls, ${rec.decisions.length} decisions)`);
const driver = openDriver();
try {
  const report = await replay(rec, { driver, root: ROOT, delayMs, log: (l) => console.log(l) });
  if (report.resultMismatches.length > 0) console.log(`note: ${report.resultMismatches.length} write result(s) differ from the recording (calls ${report.resultMismatches.join(', ')})`);
  if (!report.ok) {
    console.error(`replay: the graph does not match the recording:\n- ${report.differences.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('replay: counts and validator verdicts match the recording');
  }
} catch (e) {
  console.error(`replay: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
