import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The skill's escalation rules: the architect is asked through a gate (recorded), never only in chat. */

const SKILL = readFileSync('plugin/skills/plan-integration/SKILL.md', 'utf8');

describe('plan-integration skill', () => {
  it('asks the architect only through a gate', () => {
    expect(SKILL).toMatch(/7\. \*\*Ask through a gate, never only in chat\.\*\*[\s\S]{0,400}mcp__gate__request_approval/);
    expect(SKILL).not.toMatch(/stop and ask/i);
    for (const m of SKILL.matchAll(/ask the architect(?! \(rule 7\))/gi)) {
      expect(SKILL.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 40), 'every "ask the architect" points to rule 7').toMatch(/rule 7|never only in chat|"ask the architect"/);
    }
  });

  it('repairs a catalog cycle (V3, P5) with the near-miss instead of stopping', () => {
    expect(SKILL).toMatch(/\*\*V3 FAIL\*\*[\s\S]{0,700}`near_miss`[\s\S]{0,80}`replace_selection`/);
    expect(SKILL).toMatch(/Never edit the catalog/);
  });

  it('handles a use case with no catalog pattern', () => {
    expect(SKILL).toMatch(/If `candidates` returns no rows[\s\S]{0,300}no catalog pattern/);
  });
});
