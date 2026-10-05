import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/** Builds viz/ into viz/dist when any source is newer than the last build (T4.2). */

const VIZ = fileURLToPath(new URL('../viz', import.meta.url));
const INDEX = join(VIZ, 'dist/index.html');

const newest = (dir: string): number =>
  Math.max(
    0,
    ...readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs)),
  );
const mtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export async function buildUiIfStale(): Promise<boolean> {
  const sources = Math.max(newest(join(VIZ, 'src')), mtime(join(VIZ, 'index.html')), mtime(join(VIZ, 'vite.config.ts')));
  if (mtime(INDEX) >= sources) return false;
  await build({ root: VIZ, configFile: join(VIZ, 'vite.config.ts'), logLevel: 'warn' });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log((await buildUiIfStale()) ? 'ui: built viz/dist' : 'ui: viz/dist is up to date');
}
