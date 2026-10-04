import { describe, expect, it } from 'vitest';
import { checkSurface, skillToolNames, agentToolNames } from '../../scripts/check-tool-surface.js';

/** T2.6 / gotcha 03: tools referenced in the skill = tools granted to the agent ⊆ tools served; the guard covers every write tool. */

const served = {
  'neo4j-read': ['get-schema', 'read-cypher', 'list-gds-procedures'],
  'neo4j-write': ['get-schema', 'read-cypher', 'write-cypher', 'list-gds-procedures'],
  gate: ['request_approval'],
};
const SKILL = 'Use `mcp__neo4j-read__read-cypher`, then `mcp__neo4j-write__write-cypher`, then mcp__gate__request_approval.';
const AGENT = ['mcp__neo4j-read__read-cypher', 'mcp__neo4j-write__write-cypher', 'mcp__gate__request_approval'];
const HOOKS = ['mcp__neo4j-write__write-cypher'];

const base = { skillTools: skillToolNames(SKILL), agentTools: AGENT, served, hookMatchers: HOOKS };

describe('tool-name extraction', () => {
  it('finds mcp__server__tool names in skill text, once each', () => {
    expect(skillToolNames(`${SKILL} again mcp__gate__request_approval.`)).toEqual([
      'mcp__gate__request_approval',
      'mcp__neo4j-read__read-cypher',
      'mcp__neo4j-write__write-cypher',
    ]);
  });
  it('reads the comma-separated tools of agent frontmatter', () => {
    expect(agentToolNames('---\nname: planner\ntools: mcp__a__x, mcp__b__y\nmodel: inherit\n---\nbody')).toEqual(['mcp__a__x', 'mcp__b__y']);
  });
});

describe('checkSurface', () => {
  it('passes when skill = agent ⊆ served and the guard covers write-cypher', () => {
    expect(checkSurface(base)).toEqual([]);
  });

  it('fails when the skill uses a tool the agent is not granted', () => {
    expect(checkSurface({ ...base, agentTools: AGENT.slice(0, 2) })).toContainEqual(
      expect.stringMatching(/mcp__gate__request_approval.*not granted/),
    );
  });

  it('fails when the agent is granted a tool the skill never uses', () => {
    expect(checkSurface({ ...base, agentTools: [...AGENT, 'mcp__neo4j-read__get-schema'] })).toContainEqual(
      expect.stringMatching(/mcp__neo4j-read__get-schema.*not used/),
    );
  });

  it('fails when a granted tool is not served by any server', () => {
    const problems = checkSurface({
      ...base,
      skillTools: [...base.skillTools, 'mcp__ontology__get_ontology'],
      agentTools: [...AGENT, 'mcp__ontology__get_ontology'],
    });
    expect(problems).toContainEqual(expect.stringMatching(/mcp__ontology__get_ontology.*not served/));
  });

  it('fails when a hook matcher matches no served tool', () => {
    expect(checkSurface({ ...base, hookMatchers: ['mcp__neo4j_write__write_cypher'] })).toContainEqual(
      expect.stringMatching(/matcher .* matches no served tool/),
    );
  });

  it('fails when a served write tool is not covered by the guard hook', () => {
    expect(checkSurface({ ...base, hookMatchers: [] })).toContainEqual(
      expect.stringMatching(/mcp__neo4j-write__write-cypher is not guarded/),
    );
  });
});

describe('the real repo (launches every .mcp.json server)', () => {
  it('passes: skill = agent ⊆ served, and write-cypher is guarded', async () => {
    const { runCheck } = await import('../../scripts/check-tool-surface.js');
    expect(await runCheck()).toEqual([]);
  }, 60_000);
});
