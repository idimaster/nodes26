import { describe, expect, it } from 'vitest';
import { classifyBuyBuild } from '../src/index.js';
import { TH } from './th.js';

const row = (capability_id: string, integrate_effort: number | null, build_effort: number, coverage: number) => ({
  capability_id,
  integrate_effort,
  build_effort,
  coverage,
});

describe('classifyBuyBuild (DESIGN §2.6)', () => {
  const out = classifyBuyBuild(
    [
      row('retire-me', 1, 20, 0.85),
      row('integrate-me', 6, 20, 0.7),
      row('edge-integrate', 10, 20, 0),
      row('build-me', 20, 8, 0),
      row('review-me', 13, 14, 0.5),
      row('unplanned-me', null, 10, 0.2),
    ],
    TH,
  );

  it('applies the rules in order, first match wins', () => {
    expect(out.outcomes.map((o) => [o.capability_id, o.outcome, o.rule])).toEqual([
      ['retire-me', 'retire', 1],
      ['integrate-me', 'integrate', 2],
      ['edge-integrate', 'integrate', 2],
      ['build-me', 'build', 3],
      ['review-me', 'review', 4],
    ]);
    expect(out.rule_version).toBe('bb1-v1');
  });

  it('reports rows without an integrate effort as unplanned', () => {
    expect(out.unplanned).toEqual(['unplanned-me']);
  });
});
