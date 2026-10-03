import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTerms, scan } from '../../scripts/denylist-check.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runCheck(env: Record<string, string | undefined>) {
  const result = spawnSync('npx', ['tsx', 'scripts/denylist-check.ts'], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries({ ...process.env, DENYLIST_FILE: undefined, ...env }).filter(([, v]) => v !== undefined),
    ) as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function termsFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'denylist-')), 'terms.txt');
  writeFileSync(path, content);
  return path;
}

describe('parseTerms', () => {
  it('ignores blank lines and # comments and trims', () => {
    expect(parseTerms('# real names\n  Zorblat Systems  \n\nQuixotech\n')).toEqual(['Zorblat Systems', 'Quixotech']);
  });
});

describe('scan', () => {
  const terms = ['Zorblat Systems', 'Quixotech'];

  it('finds a term in a file, case-insensitively, with its line number', () => {
    const hits = scan(terms, [{ where: 'docs/a.md', text: 'line one\nwe met ZORBLAT systems today\n' }]);
    expect(hits).toEqual([{ where: 'docs/a.md:2', term: 1 }]);
  });

  it('finds a term in a commit message', () => {
    const hits = scan(terms, [{ where: 'commit 1234567', text: 'T9.9: talk to quixotech' }]);
    expect(hits).toEqual([{ where: 'commit 1234567:1', term: 2 }]);
  });

  it('matches whole words only', () => {
    expect(scan(['Quixotech'], [{ where: 'x', text: 'quixotechample and prequixotech' }])).toEqual([]);
  });

  it('treats terms as literal text, not regular expressions', () => {
    expect(scan(['a.c'], [{ where: 'x', text: 'abc' }])).toEqual([]);
    expect(scan(['a.c'], [{ where: 'x', text: 'see a.c here' }])).toHaveLength(1);
  });
});

describe('denylist-check CLI (T1.5)', () => {
  it('fails when DENYLIST_FILE is not set (never a silent pass)', () => {
    const { status, output } = runCheck({});
    expect(status).not.toBe(0);
    expect(output).toMatch(/DENYLIST_FILE is not set/);
  });

  it('fails when the denylist is empty', () => {
    const { status, output } = runCheck({ DENYLIST_FILE: termsFile('# nothing\n') });
    expect(status).not.toBe(0);
    expect(output).toMatch(/no terms/);
  });

  it('fails when the denylist lives inside the repository', () => {
    const { status, output } = runCheck({ DENYLIST_FILE: join(ROOT, 'LICENSE') });
    expect(status).not.toBe(0);
    expect(output).toMatch(/outside the repository/);
  });

  it('fails on a seeded test term and does not print the term', () => {
    const { status, output } = runCheck({ DENYLIST_FILE: termsFile('Harborline\n') });
    expect(status).toBe(1);
    expect(output).toMatch(/docs\/design\/DATA\.md:\d+ .*term #1/);
    expect(output).not.toMatch(/harborline/i);
  });

  it('passes on a clean tree', () => {
    // Built at runtime so the term never appears in a tracked file (including this one).
    const absent = ['zz', 'absent', Date.now().toString(36)].join('-');
    const { status, output } = runCheck({ DENYLIST_FILE: termsFile(`${absent}\n`) });
    expect(output).toMatch(/clean/);
    expect(status).toBe(0);
  });
});
