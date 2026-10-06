import { readFileSync } from 'node:fs';
import type { Driver } from 'neo4j-driver';

/**
 * Pinned versions (config/versions.json). APOC and GDS come from NEO4J_PLUGINS, which picks the version
 * compatible with the pinned image at container start, so the pin is enforced here instead: a different
 * version is an error, never a silent fallback.
 */

export interface Versions {
  node: string;
  npm: string;
  neo4j: string;
  apoc: string;
  gds: string;
  neo4j_mcp: string;
}

export const VERSIONS = JSON.parse(readFileSync(new URL('../config/versions.json', import.meta.url), 'utf8')) as Versions;

export async function checkPluginVersions(driver: Driver, pinned: Versions = VERSIONS): Promise<{ apoc: string; gds: string }> {
  const { records } = await driver.executeQuery('RETURN apoc.version() AS apoc, gds.version() AS gds');
  const apoc = String(records[0]?.get('apoc'));
  const gds = String(records[0]?.get('gds'));
  const drift = [
    apoc !== pinned.apoc ? `APOC ${apoc} is not the pinned ${pinned.apoc}` : '',
    gds !== pinned.gds ? `GDS ${gds} is not the pinned ${pinned.gds}` : '',
  ].filter(Boolean);
  if (drift.length > 0) {
    throw new Error(
      `${drift.join('; ')}. The plugins follow the Neo4j image; recreate the plugins volume (docker compose down -v && docker compose up -d --wait), or update config/versions.json if the change is intended.`,
    );
  }
  return { apoc, gds };
}
