import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VALIDATOR_FILES } from '../graph/validate.js';

/**
 * Copies the validator queries (V1–V6b) from graph/queries/validators into the skill, between
 * <!-- validators:start --> and <!-- validators:end -->. The .cypher files stay the single source;
 * a test fails when SKILL.md drifts from them. V7 is a data check for CI, not for the agent.
 */

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
  return skill.slice(0, a) + validatorSection() + skill.slice(b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SKILL_FILE, syncedSkill(readFileSync(SKILL_FILE, 'utf8')));
  console.log('skill:sync: validator queries copied into SKILL.md');
}
