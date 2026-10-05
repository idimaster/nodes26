import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageFloor, runValidators } from '../graph/validate.js';

/**
 * Knowledge-edge coverage report (T3.3, V7, gotcha 09): the share of catalog patterns with any
 * REQUIRES, CONFLICTS, or AUGMENTS edge. Writes a JSON artifact for CI and exits 1 below the floor
 * in config/thresholds.json, because V1 and V2 cannot fire on edges that are not in the catalog.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(ROOT, outIndex >= 0 ? (args[outIndex + 1] ?? '') : 'reports/edge-coverage.json');

const floor = coverageFloor();
const [v7] = await runValidators('-', 1, { checks: ['V7'], floor });
if (!v7) throw new Error('validator V7 is missing');
const uncovered = v7.violations.map((v) => v.witness[0] as string);
const artifact = {
  check: 'V7',
  verdict: v7.verdict,
  coverage: Number((v7.coverage ?? 0).toFixed(4)),
  floor,
  examined: v7.examined,
  covered: v7.examined - uncovered.length,
  uncovered,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);

const pct = (artifact.coverage ?? 0).toFixed(2);
if (v7.verdict === 'PASS') {
  console.log(`edge coverage: ${pct} (${artifact.covered}/${artifact.examined} patterns) ≥ floor ${floor}; report: ${out}`);
} else {
  console.error(
    `edge coverage: ${v7.verdict === 'FAIL' ? `${pct} (${artifact.covered}/${artifact.examined} patterns) is below the floor ${floor}` : v7.verdict}; ` +
      `V1 and V2 cannot fire on edges that are not in the catalog. Report: ${out}`,
  );
  process.exit(1);
}
