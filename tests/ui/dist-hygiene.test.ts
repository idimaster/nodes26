import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** T4.2: the built page talks only to the gate server; it carries no database address or credentials. */

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

describe('viz/dist (built by the test global setup)', () => {
  const all = files('viz/dist').map((f) => [f, readFileSync(f, 'utf8')] as const);
  it('exists', () => {
    expect(all.map(([f]) => f)).toContain(join('viz/dist', 'index.html'));
  });
  it.each(['bolt://', 'neo4j://', 'neo4j+s://', 'NEO4J_PASSWORD', 'planner-demo', '7687'])('contains no %s', (needle) => {
    for (const [f, text] of all) expect(text.includes(needle), `${f} contains ${needle}`).toBe(false);
  });
});
