import { describe, expect, it } from 'vitest';
import { classifyFinding } from '../src/index.js';
import { TH } from './th.js';

const f = (kind: string, evidence_type: string, confidence: number) => ({ id: 'f', kind, evidence_type, confidence });

describe('classifyFinding (DESIGN §2.1)', () => {
  it.each([
    ['gap', 'code_inspection', 0.9, 'gap'],
    ['gap', 'rfi', 0.7, 'gap'],
    ['gap', 'rfi', 0.69, 'assumption'],
    ['gap', 'interview', 0.95, 'assumption'],
    ['assumption', 'vendor_docs', 0.9, 'gap'],
    ['assumption', 'assumption', 0.9, 'assumption'],
    ['capability', 'vendor_docs', 0.85, 'capability'],
    ['capability', 'assumption', 0.93, 'assumption'],
    ['capability', 'code_inspection', 0.5, 'assumption'],
    ['risk', 'interview', 0.1, 'risk'],
    ['service', 'assumption', 0.1, 'service'],
  ] as const)('%s / %s / %s -> %s', (kind, ev, conf, expected) => {
    expect(classifyFinding(f(kind, ev, conf), TH)).toBe(expected);
  });
});

describe('classifyFinding input errors', () => {
  it('rejects an unknown kind', () => {
    expect(() => classifyFinding(f('rumour', 'rfi', 0.9), TH)).toThrow(/unknown finding kind "rumour"/);
  });
});
