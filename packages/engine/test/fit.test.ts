import { describe, expect, it } from 'vitest';
import { analyzePatternFit, bandFor, tokenize, type FitCandidate, type FitInput } from '../src/index.js';
import { TH } from './th.js';

const scim: FitCandidate = {
  id: 'scim-x',
  name: 'SCIM sync',
  description: 'Remove accounts automatically',
  solves: ['user-provisioning'],
  strategies: ['bridge'],
  requires: [],
  not_recommended_when: [],
};
const cutover: FitCandidate = {
  id: 'cutover-x',
  name: 'Directory cutover',
  description: 'Move every identity at once',
  solves: ['user-provisioning'],
  strategies: ['transform'],
  requires: ['trust-x'],
  not_recommended_when: ['rule one', 'rule two'],
};
const audit: FitCandidate = {
  id: 'audit-x',
  name: 'Audit pipeline',
  description: 'Forward events',
  solves: ['audit-logging'],
  strategies: ['bridge'],
  requires: [],
  not_recommended_when: [],
};

const input = (over: Partial<FitInput['deal_context']> = {}): FitInput => ({
  use_case: {
    use_case_id: 'user-provisioning',
    description: 'Leavers lose access to every system automatically',
    finding_texts: ['Accounts are removed by hand; no SCIM endpoint'],
  },
  deal_context: {
    strategy: 'bridge',
    target_company: 'Nimbus Ledger',
    acquirer: 'Harborline Software',
    selected_patterns: [],
    flagged_rules: { 'cutover-x': ['rule one'] },
    ...over,
  },
  candidates: [cutover, audit, scim],
});

describe('tokenize', () => {
  it('lowercases, keeps [a-z0-9] runs of 3+, drops stopwords and deal names', () => {
    expect(tokenize("The target's SCIM-2.0 endpoint for Nimbus", TH, ['Nimbus Ledger'])).toEqual(
      new Set(['target', 'scim', 'endpoint']),
    );
  });
});

describe('analyzePatternFit (DESIGN §2.2)', () => {
  it('scores the five signals and ranks by score', () => {
    const ranked = analyzePatternFit(input(), TH);
    expect(ranked.map((r) => [r.pattern, r.score, r.band])).toEqual([
      ['scim-x', 92, 'recommend'], // 35 + 20*3/5 + 20 + 15 + 10
      ['audit-x', 45, 'surface'], // 0 + 0 + 20 + 15 + 10
      ['cutover-x', 44, 'surface'], // 35 + 20*1/5 + 0 + 0 + 10*(1 - 1/2)
    ]);
    expect(ranked[0]?.signals).toEqual({
      use_case_match: 35,
      text_overlap: 12,
      strategy_compat: 20,
      prereq_satisfaction: 15,
      constraint_compat: 10,
    });
    expect(ranked.find((r) => r.pattern === 'cutover-x')?.flags).toEqual(['rule one']);
  });

  it('counts satisfied prerequisites from patterns already selected', () => {
    const ranked = analyzePatternFit(input({ selected_patterns: ['trust-x'] }), TH);
    expect(ranked.find((r) => r.pattern === 'cutover-x')?.signals.prereq_satisfaction).toBe(15);
  });

  it('applies the reuse penalty after two free picks: 3rd use -5, 4th use -10', () => {
    const third = analyzePatternFit(input({ selected_patterns: ['scim-x', 'scim-x'] }), TH)[0];
    const fourth = analyzePatternFit(input({ selected_patterns: ['scim-x', 'scim-x', 'scim-x'] }), TH)[0];
    expect([third?.reuse_penalty, third?.score]).toEqual([5, 87]);
    expect([fourth?.reuse_penalty, fourth?.score]).toEqual([10, 82]);
  });

  it('counts a flagged rule once, however often it is flagged', () => {
    const [r] = analyzePatternFit(
      { ...input({ flagged_rules: { 'cutover-x': ['rule one', 'rule one', 'rule one', 'unknown rule'] } }), candidates: [cutover] },
      TH,
    );
    expect(r?.signals.constraint_compat).toBe(5);
    expect(r?.flags).toEqual(['rule one']);
  });

  it('clamps the score at 0', () => {
    const hopeless: FitCandidate = { ...cutover, id: 'z', solves: ['other'], description: 'zzz', name: 'qqq' };
    const [r] = analyzePatternFit(
      {
        ...input({ selected_patterns: ['z', 'z', 'z'], flagged_rules: { z: ['rule one', 'rule two'] } }),
        candidates: [hopeless],
      },
      TH,
    );
    expect(r?.score).toBe(0);
    expect(r?.band).toBe('hidden');
  });

  it('breaks score ties by pattern id', () => {
    const a = { ...audit, id: 'b-same' };
    const b = { ...audit, id: 'a-same' };
    expect(analyzePatternFit({ ...input(), candidates: [a, b] }, TH).map((r) => r.pattern)).toEqual(['a-same', 'b-same']);
  });
});

describe('bandFor', () => {
  it.each([
    [100, 'recommend'],
    [60, 'recommend'],
    [59.9, 'surface'],
    [40, 'surface'],
    [39.9, 'review'],
    [25, 'review'],
    [24.9, 'hidden'],
    [0, 'hidden'],
  ] as const)('%s -> %s', (score, band) => {
    expect(bandFor(score, TH)).toBe(band);
  });
});
