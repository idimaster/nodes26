import { describe, expect, it } from 'vitest';
import { estimateProvenance } from '../src/index.js';
import { TH } from './th.js';

const task = { id: 'p.t', weeks_o: 1, weeks_e: 2, weeks_p: 4 };

describe('estimateProvenance (DESIGN §2.4)', () => {
  it('uses the baseline with no history', () => {
    expect(estimateProvenance({ task, observations: [], modifiers: [] }, TH)).toEqual({
      task_id: 'p.t',
      baseline: 2,
      history_avg: null,
      n: 0,
      modifiers: [],
      result: 2,
      band: [1, 4],
    });
  });

  it('blends baseline and history below the minimum observations', () => {
    // (2 + 2*3) / 3 = 2.667 -> 2.7; band [1, 4] * 2.7 / 2
    expect(estimateProvenance({ task, observations: [3, 3], modifiers: [] }, TH)).toMatchObject({
      history_avg: 3,
      n: 2,
      result: 2.7,
      band: [1.4, 5.4],
    });
  });

  it('uses the history average at the minimum observations', () => {
    expect(estimateProvenance({ task, observations: [2, 3, 4], modifiers: [] }, TH)).toMatchObject({
      history_avg: 3,
      n: 3,
      result: 3,
      band: [1.5, 6],
    });
  });

  it('refuses a task without a positive baseline', () => {
    expect(() => estimateProvenance({ task: { ...task, weeks_e: 0 }, observations: [], modifiers: [] }, TH)).toThrow(
      /no positive weeks_e/,
    );
  });

  it('multiplies modifiers', () => {
    const modifiers = [{ name: 'new team', factor: 1.2 }];
    expect(estimateProvenance({ task, observations: [], modifiers }, TH)).toMatchObject({
      modifiers,
      result: 2.4,
      band: [1.2, 4.8],
    });
  });
});
