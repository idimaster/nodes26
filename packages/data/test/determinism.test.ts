import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, generateFiles } from '../src/index.js';

describe('generate-data is deterministic (T1.3)', () => {
  const first = generateFiles();

  it('produces identical output on a second run', () => {
    expect(generateFiles()).toEqual(first);
  });

  it('matches the committed generated files (run npm run generate)', () => {
    expect([...first.keys()].sort()).toEqual([
      'deals/nimbus/findings.generated.json',
      'history/quarry.generated.json',
      'history/tidewater.generated.json',
      'manifest.json',
    ]);
    for (const [path, content] of first) {
      expect(readFileSync(join(DATA_DIR, path), 'utf8'), path).toBe(content);
    }
  });
});
