import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ontology } from '@planner/ontology';
import { favorites, grass } from '../../scripts/gen-browser.js';

/** T4.2 addendum §5.5: the Browser files are generated and stay in sync with the UI queries and palette. */

describe('browser files', () => {
  it('are up to date (npm run browser:gen)', () => {
    expect(readFileSync('browser/style.grass', 'utf8')).toBe(grass());
    expect(readFileSync('browser/favorites.cypher', 'utf8')).toBe(favorites());
  });
  it('style every label with the deck palette', () => {
    for (const l of ontology.labels) expect(grass()).toContain(`node.${l.name} {`);
    expect(grass()).toContain('#B79CFF');
  });
  it('carry the three scenes, iteration_diff, resource load, BB1, and the validators', () => {
    const f = favorites();
    for (const t of ['Scene 1', 'Scene 2', 'Scene 3', 'Iteration diff', 'Resource load', 'BB1', 'v2-conflicting-selections']) expect(f).toContain(t);
  });
});
