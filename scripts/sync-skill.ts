import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALIDATOR_FILES } from '../graph/validate.js';

/**
 * Keeps the skill's queries in sync with their .cypher files, which stay the single source; a test
 * fails when SKILL.md drifts from them:
 * - V1–V6b from graph/queries/validators go between <!-- validators:start --> and <!-- validators:end -->
 *   (V7 is a data check for CI, not for the agent);
 * - each graph/queries/skill/<name>.cypher replaces the body of the <!-- query: <name> --> block.
 */

const SKILL_QUERIES = fileURLToPath(new URL('../graph/queries/skill', import.meta.url));

export const SKILL_FILE = fileURLToPath(new URL('../plugin/skills/plan-integration/SKILL.md', import.meta.url));
const START = '<!-- validators:start -->';
const END = '<!-- validators:end -->';

export function validatorSection(): string {
  const blocks = VALIDATOR_FILES.filter((v) => v.check !== 'V7').map(
    (v) => `<!-- query: ${v.check.toLowerCase()} -->\n\`\`\`cypher\n${v.query.trim()}\n\`\`\``,
  );
  return `${START}\n<!-- generated from graph/queries/validators by npm run skill:sync; do not edit by hand -->\n\n${blocks.join('\n\n')}\n${END}`;
}

export function syncedSkill(skill: string): string {
  const a = skill.indexOf(START);
  const b = skill.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`SKILL.md needs ${START} … ${END} markers`);
  let out = skill.slice(0, a) + validatorSection() + skill.slice(b + END.length);
  for (const file of readdirSync(SKILL_QUERIES).filter((f) => f.endsWith('.cypher')).sort()) {
    const name = file.replace(/\.cypher$/, '');
    const block = new RegExp(`(<!-- query: ${name} -->\\n\`\`\`cypher\\n)[\\s\\S]*?(\`\`\`)`);
    if (!block.test(out)) throw new Error(`SKILL.md has no <!-- query: ${name} --> block for graph/queries/skill/${file}`);
    const body = readFileSync(join(SKILL_QUERIES, file), 'utf8').trim();
    out = out.replace(block, (_m, head: string, tail: string) => `${head}${body}\n${tail}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SKILL_FILE, syncedSkill(readFileSync(SKILL_FILE, 'utf8')));
  console.log('skill:sync: validator and named queries copied into SKILL.md');
}
