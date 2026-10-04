import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { thresholdsSchema, type Thresholds } from '@planner/engine';
import { createEngineServer } from './tools.js';

const DEFAULT_THRESHOLDS = fileURLToPath(new URL('../../../config/thresholds.json', import.meta.url));

/** Loads thresholds once at startup. A missing or invalid file stops the server: there are no defaults. */
function loadThresholds(path: string): Thresholds {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read thresholds from ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = thresholdsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid thresholds in ${path}:\n${parsed.error.message}`);
  return parsed.data;
}

async function main(): Promise<void> {
  const path = process.env.THRESHOLDS_FILE ?? DEFAULT_THRESHOLDS;
  const server = createEngineServer(loadThresholds(path));
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`planner-engine: ready (thresholds: ${path})`);
}

main().catch((error: unknown) => {
  console.error(`planner-engine: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
