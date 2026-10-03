import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Public-repo hygiene (CLAUDE.md, DATA.md): fails if any tracked file or commit message
 * contains a denylisted term. Terms come from $DENYLIST_FILE, which lives outside the repo
 * (in CI, a secret). Reports never print the term, because CI logs of a public repo are public.
 */

export interface Text {
  where: string;
  text: string;
}

export interface Hit {
  where: string;
  /** 1-based index of the term in the denylist file (comments and blanks excluded). */
  term: number;
}

export function parseTerms(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^\w/.test(term) ? '\\b' : '';
  const end = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${start}${escaped}${end}`, 'i');
}

/** Case-insensitive, whole-word, literal matching; one hit per (line, term). */
export function scan(terms: string[], texts: Text[]): Hit[] {
  const patterns = terms.map(termPattern);
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    text.split('\n').forEach((line, i) => {
      patterns.forEach((p, t) => {
        if (p.test(line)) hits.push({ where: `${where}:${i + 1}`, term: t + 1 });
      });
    });
  }
  return hits;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function trackedFiles(): Text[] {
  return git('ls-files', '-z')
    .split('\0')
    .filter((p) => p !== '')
    .flatMap((path) => {
      const full = join(ROOT, path);
      if (!existsSync(full)) return []; // deleted in the working tree but not yet staged
      const text = readFileSync(full, 'utf8');
      return text.includes('\0') ? [] : [{ where: path, text }]; // skip binary files
    });
}

function commitMessages(): Text[] {
  return git('log', '--format=%H%x00%B%x1e', 'HEAD')
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.includes('\0'))
    .map((entry) => {
      const [sha = '', message = ''] = entry.split('\0');
      return { where: `commit ${sha.slice(0, 12)}`, text: message };
    });
}

function fail(message: string): never {
  console.error(`denylist: ${message}`);
  process.exit(2);
}

function main(): void {
  const file = process.env.DENYLIST_FILE;
  if (!file) fail('DENYLIST_FILE is not set; the check was NOT run. Point it at the denylist (kept outside this repo).');
  if (!existsSync(file)) fail(`DENYLIST_FILE does not exist: ${file}`);
  const root = realpathSync(ROOT);
  const resolved = realpathSync(file);
  if (resolved === root || resolved.startsWith(root + sep)) {
    fail('DENYLIST_FILE must live outside the repository, or it would publish the very names it protects.');
  }
  const terms = parseTerms(readFileSync(resolved, 'utf8'));
  if (terms.length === 0) fail('the denylist has no terms; the check was NOT run.');

  const files = trackedFiles();
  const commits = commitMessages();
  const hits = scan(terms, [...files, ...commits]);
  if (hits.length > 0) {
    for (const h of hits) console.error(`${h.where} matches denylist term #${h.term}`);
    console.error(`denylist: ${hits.length} match(es). Replace them with fictional names (see DATA.md).`);
    process.exit(1);
  }
  console.log(`denylist: clean (${terms.length} terms, ${files.length} files, ${commits.length} commit messages)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
