import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';

/** T3.3: the edge-coverage report passes on the catalog and fails CI on a sparse one (gotcha 09). */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let driver: Driver;

function report() {
  const out = join(mkdtempSync(join(tmpdir(), 'coverage-')), 'edge-coverage.json');
  const r = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/edge-coverage.ts', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, output: r.stdout + r.stderr, artifact: JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown> };
}

beforeAll(async () => {
  driver = openDriver();
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
});

afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

describe('scripts/edge-coverage.ts', () => {
  it('passes on the demo catalog and writes the artifact', () => {
    const r = report();
    expect(r.status).toBe(0);
    expect(r.artifact).toMatchObject({ check: 'V7', verdict: 'PASS', floor: 0.6, examined: 29, covered: 27 });
    expect(r.artifact.uncovered).toEqual(['bulk-migration', 'container-replatform-fastpath']);
    expect(r.output).toMatch(/0\.93/);
  });

  it('fails on a sparse catalog (edges on 3 of 29 patterns)', async () => {
    await driver.executeQuery(
      `MATCH (p:Pattern)-[r:REQUIRES|CONFLICTS|AUGMENTS]-(:Pattern)
       WHERE NOT p.id IN ['cdc-replication', 'batch-etl-export', 'scim-provisioning']
       DELETE r`,
    );
    const r = report();
    expect(r.status).toBe(1);
    expect(r.artifact).toMatchObject({ verdict: 'FAIL', examined: 29 });
    expect(Number(r.artifact.coverage)).toBeLessThan(0.6);
    expect(r.output).toMatch(/below the floor 0\.6/);
  });
});
