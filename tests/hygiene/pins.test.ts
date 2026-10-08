import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { checkPluginVersions, VERSIONS } from '../../graph/versions.js';

/** T5.2: no unpinned dependencies, anywhere the build or the demo pulls something in. */

const json = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
type Pkg = { name: string; version: string; packageManager?: string; engines?: { node?: string } } & Record<string, Record<string, string> | string | undefined>;
const PACKAGES = ['package.json', ...['packages', 'examples'].flatMap((dir) => readdirSync(dir).map((p) => join(dir, p, 'package.json')))];
const WORKSPACES = new Map(PACKAGES.slice(1).map((p) => [json<Pkg>(p).name, json<Pkg>(p).version]));
const EXACT = /^\d+\.\d+\.\d+$/;

describe('pins', () => {
  it.each(PACKAGES)('%s: every dependency is an exact version', (p) => {
    const pkg = json<Pkg>(p);
    const loose: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries((pkg[field] as Record<string, string> | undefined) ?? {})) {
        const ok = WORKSPACES.has(name) ? range === WORKSPACES.get(name) : EXACT.test(range);
        if (!ok) loose.push(`${field}.${name}: ${range}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('Node and npm are exact, and agree with config/versions.json', () => {
    const root = json<Pkg>('package.json');
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe(VERSIONS.node);
    expect(root.engines?.node).toBe(VERSIONS.node);
    expect(root.packageManager).toBe(`npm@${VERSIONS.npm}`);
  });

  it('every GitHub Action is pinned to a commit SHA', () => {
    const uses = readdirSync('.github/workflows').flatMap((f) =>
      [...readFileSync(join('.github/workflows', f), 'utf8').matchAll(/uses:\s*(\S+)/g)].map((m) => `${f}: ${m[1]}`),
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
  });

  it('every job runs on a pinned runner image, not a moving *-latest label', () => {
    const runners = readdirSync('.github/workflows').flatMap((f) =>
      [...readFileSync(join('.github/workflows', f), 'utf8').matchAll(/runs-on:\s*(\S+)/g)].map((m) => `${f}: ${m[1]}`),
    );
    expect(runners.length).toBeGreaterThan(0);
    expect(runners.filter((r) => /-latest$/.test(r))).toEqual([]);
  });

  it('the Neo4j image and the Neo4j MCP server agree with config/versions.json', () => {
    expect(readFileSync('docker-compose.yml', 'utf8')).toMatch(new RegExp(`image: neo4j:${VERSIONS.neo4j.replaceAll('.', '\\.')}-community\\n`));
    expect(json<{ version: string }>('config/neo4j-mcp.json').version).toBe(VERSIONS.neo4j_mcp);
  });
});

describe('APOC and GDS (resolved by the image at start, so checked at run time)', () => {
  let driver: Driver;
  beforeAll(() => {
    driver = openDriver();
  });
  afterAll(async () => {
    await driver.close();
  });

  it('the running versions are the pinned ones', async () => {
    expect(await checkPluginVersions(driver)).toEqual({ apoc: VERSIONS.apoc, gds: VERSIONS.gds });
  });

  it('a drift is an error that says what to do', async () => {
    await expect(checkPluginVersions(driver, { ...VERSIONS, gds: '0.0.1' })).rejects.toThrow(/GDS .* is not the pinned 0\.0\.1.*config\/versions\.json/);
  });
});
