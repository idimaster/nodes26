import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** T5.1: the README is the quickstart; its links, commands, and tiers must stay true. */

const README = readFileSync('README.md', 'utf8');
const SCRIPTS = Object.keys((JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts);
const DOCS = ['README.md', 'gotchas/README.md', ...readdirSync('gotchas').filter((d) => /^\d\d-/.test(d)).map((d) => `gotchas/${d}/README.md`)];

describe('README', () => {
  it('describes tiers 0, 1, and 2, the architecture, the gotchas, and the gateway note', () => {
    for (const h of [/^## Tier 0\b/m, /^## Tier 1\b/m, /^## Tier 2\b/m, /^## Architecture\b/m, /^## Gotchas\b/m]) expect(README).toMatch(h);
    expect(README).toMatch(/```mermaid\n[\s\S]+?```/);
    expect(README).toMatch(/ANTHROPIC_BASE_URL[\s\S]{0,400}experimental/i);
  });

  it('lists every gotcha folder', () => {
    for (const d of readdirSync('gotchas').filter((x) => /^\d\d-/.test(x))) expect(README).toContain(`gotchas/${d}`);
  });

  it('only mentions npm scripts that exist', () => {
    const used = [...new Set([...README.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1] as string))];
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((s) => !SCRIPTS.includes(s))).toEqual([]);
  });

  it.each(DOCS)('%s has no broken relative links', (doc) => {
    const text = readFileSync(doc, 'utf8');
    const links = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1] as string).filter((l) => !/^[a-z]+:/.test(l));
    const broken = links.filter((l) => !existsSync(resolve(dirname(doc), l)));
    expect(broken).toEqual([]);
  });

  it('points at scripts that exist', () => {
    for (const f of ['scripts/quickstart.sh', 'scripts/fresh-clone-check.sh']) {
      expect(existsSync(join(f)), f).toBe(true);
      expect(README).toContain(f.endsWith('quickstart.sh') ? 'npm run quickstart' : f);
    }
  });
});
