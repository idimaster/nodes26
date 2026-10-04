import { describe, expect, it } from 'vitest';
import { recommendStrategy } from '../src/index.js';
import { TH } from './th.js';

describe('recommendStrategy (DESIGN §2.1)', () => {
  it('scores absorbable capabilities for transform, distinctive ones and high risks for bridge', () => {
    const ranked = recommendStrategy(
      {
        findings: [
          { id: 'c1', kind: 'capability', severity: 'medium', capability_type: 'x' },
          { id: 'c2', kind: 'capability', severity: 'low', capability_type: 'y' },
          { id: 'c3', kind: 'capability', severity: 'low', capability_type: 'z' },
          { id: 'r1', kind: 'risk', severity: 'high' },
          { id: 'r2', kind: 'risk', severity: 'medium' },
          { id: 'g1', kind: 'gap', severity: 'critical' },
        ],
        coverage: { x: 0.9, y: 0.5 },
      },
      TH,
    );
    // bridge 50 + c2 + c3 + r1 = 80; transform 50 + c1 = 60
    expect(ranked).toEqual([
      expect.objectContaining({ strategy: 'bridge', points: 80, fit_score: 57.1, finding_ids: ['c2', 'c3', 'r1'] }),
      expect.objectContaining({ strategy: 'transform', points: 60, fit_score: 42.9, finding_ids: ['c1'] }),
    ]);
    expect(ranked[0]?.rationale).toMatch(/c2/);
  });

  it('refuses a capability finding without a capability type', () => {
    expect(() =>
      recommendStrategy({ findings: [{ id: 'c4', kind: 'capability', severity: 'low' }], coverage: {} }, TH),
    ).toThrow(/c4 has no capability_type/);
  });

  it('breaks a tie toward the configured strategy', () => {
    const ranked = recommendStrategy({ findings: [], coverage: {} }, TH);
    expect(ranked.map((r) => [r.strategy, r.fit_score])).toEqual([
      ['bridge', 50],
      ['transform', 50],
    ]);
  });
});
