import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { DATA_DIR, readDataset, validateDataset, type Manifest } from '@planner/data';
import { applySchema, SCHEMA_FILE } from '../apply-schema.js';
import { openDriver } from '../connection.js';
import { checkPluginVersions } from '../versions.js';
import { loadCatalog } from './catalog.js';
import { loadDeal } from './deal.js';
import { loadHistory } from './history.js';
import { verifyLoadedDataset, type VerificationMode } from './verify.js';

const sorted = (rows: [string, number][]): Record<string, number> =>
  Object.fromEntries(rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Node counts per label and relationship counts per type, in the manifest's shape. */
export async function graphCounts(driver: Driver): Promise<Manifest> {
  const n = await driver.executeQuery('MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS c');
  const r = await driver.executeQuery('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS c');
  return {
    nodes: sorted(n.records.map((x) => [x.get('label') as string, neo4j.integer.toNumber(x.get('c'))])),
    relationships: sorted(r.records.map((x) => [x.get('type') as string, neo4j.integer.toNumber(x.get('c'))])),
  };
}

/**
 * Applies the schema, validates the full dataset against the ontology, loads catalog, deal, and
 * history (each nodes first, then relationships), and verifies the graph against data/manifest.json.
 * Expects a database without other per-deal data (a fresh one, or one wiped by reset-demo.sh).
 */
export async function loadAll(driver: Driver, dir = DATA_DIR, mode: VerificationMode = 'strict'): Promise<Manifest> {
  await applySchema(driver, readFileSync(SCHEMA_FILE, 'utf8'));

  const problems = validateDataset(readDataset(dir));
  if (problems.length > 0) throw new Error(`data is invalid; nothing was loaded:\n- ${problems.join('\n- ')}`);

  await loadCatalog(driver, dir);
  await loadDeal(driver, dir);
  await loadHistory(driver, dir);

  return (await verifyLoadedDataset(driver, { dir, mode })).physicalCounts;
}

async function main(): Promise<void> {
  const driver = openDriver();
  try {
    const plugins = await checkPluginVersions(driver);
    const retained = process.argv.includes('--retain-active-global-terms');
    const counts = await loadAll(driver, DATA_DIR, retained ? 'retain-active-global-terms' : 'strict');
    const n = Object.values(counts.nodes).reduce((s, x) => s + x, 0);
    const r = Object.values(counts.relationships).reduce((s, x) => s + x, 0);
    console.log(`load: ${n} physical nodes and ${r} relationships; baseline verified against data/manifest.json; retained terms: ${counts.nodes.OntologyTerm ?? 0} (APOC ${plugins.apoc}, GDS ${plugins.gds})`);
  } finally {
    await driver.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
