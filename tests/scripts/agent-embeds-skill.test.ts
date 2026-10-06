import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_FILE, SKILL_FILE, skillBody, syncedAgent } from '../../scripts/sync-skill.js';

/**
 * The planner agent carries the full skill in its own body (npm run skill:sync). A live run showed that the
 * `skills:` preload of a plugin skill put nothing into the agent's context, and the agent then improvised.
 */

const AGENT = readFileSync(AGENT_FILE, 'utf8');
const SKILL = readFileSync(SKILL_FILE, 'utf8');

describe('plugin/agents/planner.md', () => {
  it('is in sync: its embedded block is the SKILL.md body', () => {
    expect(AGENT).toBe(syncedAgent(AGENT, SKILL));
    const embedded = /<!-- skill:start -->\n[\s\S]*?\n\n([\s\S]*)\n<!-- skill:end -->/.exec(AGENT)?.[1];
    expect(embedded).toBe(skillBody(SKILL));
  });

  it('does not rely on the skills: preload, and escalates only through gates', () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(AGENT)?.[1] ?? '';
    expect(front).not.toMatch(/^skills:/m);
    expect(AGENT).toContain('Ask through a gate, never only in chat');
    expect(AGENT).not.toMatch(/stop and say exactly what blocks you/);
  });
});
