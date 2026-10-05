import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toolSurfaceProblems } from './after.js';
import { agentFileLoads } from './before.js';

/** Gotcha 03: tool allowlist drift. */

const FIXTURE = 'gotchas/03-tool-allowlist-drift/fixture-agent.md';

describe('03-tool-allowlist-drift', () => {
  it('before: the drifted agent file loads fine, so nothing flags it', () => {
    expect(agentFileLoads(readFileSync(FIXTURE, 'utf8'))).toBe(true);
  });

  it('after: check-tool-surface reports the drift, and the real agent passes', async () => {
    const problems = await toolSurfaceProblems(FIXTURE);
    expect(problems).toEqual([
      'mcp__ontology__get_ontology is used by the skill but not granted to the agent',
      'mcp__ontology__propose_term is used by the skill but not granted to the agent',
      'mcp__planner-graph__schedule_plan is used by the skill but not granted to the agent',
      'mcp__planner-engine__compute_schedule is granted to the agent but not used by the skill',
    ]);
    expect(await toolSurfaceProblems()).toEqual([]);
  }, 90_000);
});
