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
 * It also embeds the SKILL.md body into the planner agent (plugin/agents/planner.md), between
 * <!-- skill:start --> and <!-- skill:end -->. The agent must not depend on the `skills:` preload: a live run
 * showed that a plugin skill named there reached the agent's context empty, and the agent improvised.
 */

const SKILL_QUERIES = fileURLToPath(new URL('../graph/queries/skill', import.meta.url));

export const SKILL_FILE = fileURLToPath(new URL('../plugin/skills/plan-integration/SKILL.md', import.meta.url));
export const AGENT_FILE = fileURLToPath(new URL('../plugin/agents/planner.md', import.meta.url));
const START = '<!-- validators:start -->';
const SKILL_START = '<!-- skill:start -->';
const SKILL_END = '<!-- skill:end -->';
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

/** The skill without its frontmatter: what the agent must have in context. */
export const skillBody = (skill: string) => skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

/** The agent file with the current skill body embedded between the markers (frontmatter and preamble kept). */
export function syncedAgent(agent: string, skill: string): string {
  const a = agent.indexOf(SKILL_START);
  const b = agent.indexOf(SKILL_END);
  if (a === -1 || b === -1 || b < a) throw new Error(`planner.md needs ${SKILL_START} … ${SKILL_END} markers`);
  const block = `${SKILL_START}\n<!-- generated from plugin/skills/plan-integration/SKILL.md by npm run skill:sync; do not edit by hand -->\n\n${skillBody(skill)}\n${SKILL_END}`;
  return agent.slice(0, a) + block + agent.slice(b + SKILL_END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skill = syncedSkill(readFileSync(SKILL_FILE, 'utf8'));
  writeFileSync(SKILL_FILE, skill);
  writeFileSync(AGENT_FILE, syncedAgent(readFileSync(AGENT_FILE, 'utf8'), skill));
  console.log('skill:sync: validator and named queries copied into SKILL.md, and SKILL.md embedded in plugin/agents/planner.md');
}
