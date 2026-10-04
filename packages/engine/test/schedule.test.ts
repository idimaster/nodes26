import { describe, expect, it } from 'vitest';
import { CycleError, computeSchedule } from '../src/index.js';

const t = (id: string, o: number, e: number, p: number) => ({ id, weeks_o: o, weeks_e: e, weeks_p: p });

describe('computeSchedule (DESIGN §2.3, §5.2)', () => {
  const tasks = [t('a', 1, 2, 3), t('b', 2, 3, 10), t('c', 1, 1, 1), t('d', 1, 2, 9)];
  const deps = [
    { from: 'b', to: 'a' },
    { from: 'c', to: 'a' },
    { from: 'd', to: 'b' },
    { from: 'd', to: 'c' },
  ];
  const s = computeSchedule(tasks, deps);

  it('computes earliest start, wave, and critical flags', () => {
    expect(s.tasks).toEqual([
      { id: 'a', earliest_start: 0, wave: 1, on_critical_path: true },
      { id: 'b', earliest_start: 2, wave: 2, on_critical_path: true },
      { id: 'c', earliest_start: 2, wave: 2, on_critical_path: false },
      { id: 'd', earliest_start: 5, wave: 3, on_critical_path: true },
    ]);
    expect(s.finish).toBe(7);
    expect(s.critical_path).toEqual(['a', 'b', 'd']);
  });

  it('reports the PERT band over the critical path', () => {
    // means 2 + 4 + 3 = 9; sigma = sqrt((1/3)^2 + (4/3)^2 + (4/3)^2) = 1.9149
    expect(s.pert).toEqual({ mean: 9, sigma: 1.91, p10: 6.55, p90: 11.45 });
  });

  it('throws a cycle witness instead of scheduling', () => {
    const cyclic = [t('a', 1, 1, 1), t('b', 1, 1, 1), t('c', 1, 1, 1), t('d', 1, 1, 1)];
    const edges = [
      { from: 'b', to: 'c' },
      { from: 'a', to: 'b' },
      { from: 'c', to: 'a' },
      { from: 'd', to: 'a' },
    ];
    expect(() => computeSchedule(cyclic, edges)).toThrow(CycleError);
    try {
      computeSchedule(cyclic, edges);
    } catch (e) {
      expect((e as CycleError).witness).toEqual(['a', 'b', 'c', 'a']);
    }
  });

  it('finds the cycle even when the smallest id only leads into it', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'b' },
    ];
    expect(() => computeSchedule([t('a', 1, 1, 1), t('b', 1, 1, 1), t('c', 1, 1, 1), t('d', 1, 1, 1)], edges)).toThrow(
      expect.objectContaining({ witness: ['b', 'c', 'd', 'b'] }),
    );
  });

  it('reports a self-loop as a one-task cycle', () => {
    expect(() => computeSchedule([t('x', 1, 1, 1)], [{ from: 'x', to: 'x' }])).toThrow(
      expect.objectContaining({ witness: ['x', 'x'] }),
    );
  });

  it('ignores duplicate edges', () => {
    const once = computeSchedule(tasks, deps);
    expect(computeSchedule(tasks, [...deps, ...deps])).toEqual(once);
  });

  it('rejects duplicate task ids', () => {
    expect(() => computeSchedule([t('a', 1, 1, 1), t('a', 1, 2, 3)], [])).toThrow(/duplicate task id a/);
  });

  it('rejects edges to unknown tasks', () => {
    expect(() => computeSchedule([t('a', 1, 1, 1)], [{ from: 'a', to: 'zz' }])).toThrow(/unknown task zz/);
  });

  it('handles an empty plan', () => {
    expect(computeSchedule([], [])).toEqual({
      tasks: [],
      finish: 0,
      critical_path: [],
      pert: { mean: 0, sigma: 0, p10: 0, p90: 0 },
    });
  });
});
