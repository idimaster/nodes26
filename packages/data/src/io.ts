import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  buildOptionsFile,
  capabilityTypesFile,
  dealFile,
  historyFile,
  patternsFile,
  platformCapabilitiesFile,
  strategiesFile,
  tracksFile,
  useCasesFile,
} from './authoring.js';
import { normalizeCatalog, normalizeDeal, type Catalog } from './normalize.js';
import { merge, type Dataset } from './types.js';

export const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));

/** Files written by the generator, relative to the data dir. Everything else under data/ is hand-authored. */
export const GENERATED = {
  nimbusFindings: 'deals/nimbus/findings.generated.json',
  history: (code: string) => `history/${code}.generated.json`,
  manifest: 'manifest.json',
} as const;

export function readYaml<S extends z.ZodType>(dir: string, path: string, schema: S): z.infer<S> {
  const raw: unknown = parse(readFileSync(join(dir, path), 'utf8'));
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`data/${path} is invalid:\n${result.error.message}`);
  return result.data;
}

export function readCatalog(dir = DATA_DIR): Catalog {
  return {
    strategies: readYaml(dir, 'catalog/strategies.yaml', strategiesFile),
    tracks: readYaml(dir, 'catalog/tracks.yaml', tracksFile),
    useCases: readYaml(dir, 'catalog/use-cases.yaml', useCasesFile),
    capabilityTypes: readYaml(dir, 'catalog/capability-types.yaml', capabilityTypesFile),
    buildOptions: readYaml(dir, 'catalog/build-options.yaml', buildOptionsFile),
    platformCapabilities: readYaml(dir, 'catalog/platform-capabilities.yaml', platformCapabilitiesFile),
    patterns: readYaml(dir, 'catalog/patterns.yaml', patternsFile),
  };
}

export const readNimbusDeal = (dir = DATA_DIR) => readYaml(dir, 'deals/nimbus/deal.yaml', dealFile);
export const readHistorySpec = (dir = DATA_DIR) => readYaml(dir, 'history/history.yaml', historyFile);

const readJson = (dir: string, path: string): Dataset => JSON.parse(readFileSync(join(dir, path), 'utf8')) as Dataset;

/**
 * The full normalized dataset: catalog, Nimbus (hand-authored + generated), and history.
 * `generated` replaces the generated files on disk (the generator passes its fresh output).
 */
export function readDataset(dir = DATA_DIR, generated?: Dataset[]): Dataset {
  const parts =
    generated ??
    [GENERATED.nimbusFindings, ...readHistorySpec(dir).deals.map((d) => GENERATED.history(d.code))].map((p) =>
      readJson(dir, p),
    );
  return merge(normalizeCatalog(readCatalog(dir)), normalizeDeal(readNimbusDeal(dir)), ...parts);
}
