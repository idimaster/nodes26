import { describe, expect, it } from 'vitest';
import { labelNames, relationshipTypes } from '@planner/ontology';
import { nodes, readDataset, readPlanted, relationships, type Props } from '../src/index.js';

/** Data-level preconditions for the planted situations (DATA.md). Behavior is tested in M3. */

const ds = readDataset();
const planted = readPlanted();
const STRONG = new Set(['code_inspection', 'vendor_docs', 'rfi']);

const finding = (id: string): Props => {
  const f = nodes(ds, 'Finding').find((n) => n.deal_code === 'nimbus' && n.id === id);
  if (!f) throw new Error(`no Nimbus finding ${id}`);
  return f;
};
const edges = (type: string, from: string, to?: string) =>
  relationships(ds, type).filter((r) => r.from.key.id === from && (to === undefined || r.to.key.id === to));
const solves = (pattern: string, uc: string) => edges('SOLVES', pattern, uc).length === 1;
const solvers = (uc: string) => relationships(ds, 'SOLVES').filter((r) => r.to.key.id === uc).map((r) => String(r.from.key.id));
const conflicts = (a: string, b: string) => edges('CONFLICTS', a, b).length + edges('CONFLICTS', b, a).length > 0;
const isStrongGap = (f: Props) => f.kind === 'gap' && STRONG.has(String(f.evidence_type)) && Number(f.confidence) >= 0.7;

function patternTasks(pattern: string): { id: string; weeks_e: number; deps: string[] }[] {
  return edges('HAS_TASK', pattern).map((r) => {
    const id = String(r.to.key.id);
    const task = nodes(ds, 'Task').find((t) => t.id === id)!;
    const deps = relationships(ds, 'DEPENDS_ON')
      .filter((d) => d.from.label === 'Task' && d.from.key.id === id)
      .map((d) => String(d.to.key.id));
    return { id, weeks_e: Number(task.weeks_e), deps };
  });
}

function hasCycle(tasks: { id: string; deps: string[] }[]): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const deps = new Map(tasks.map((t) => [t.id, t.deps]));
  const visit = (id: string): boolean => {
    if (state.get(id) === 'visiting') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'visiting');
    const cyclic = (deps.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  return tasks.some((t) => visit(t.id));
}

describe('P1: critical identity gap whose best pattern REQUIRES an unselected federation pattern', () => {
  const p = planted.P1;
  it('the finding is a critical gap with strong evidence', () => {
    const f = finding(p.finding);
    expect(isStrongGap(f)).toBe(true);
    expect(f.severity).toBe('critical');
  });
  it('every pattern solving the use case requires the federation pattern', () => {
    expect(solves(p.pattern, p.use_case)).toBe(true);
    expect(solvers(p.use_case).length).toBeGreaterThan(0);
    for (const s of solvers(p.use_case)) expect(edges('REQUIRES', s, p.requires), s).toHaveLength(1);
  });
  it('the federation pattern does not itself solve the use case', () => {
    expect(solves(p.requires, p.use_case)).toBe(false);
  });
});

describe('P2: two use cases whose top picks CONFLICT, each with a near-miss', () => {
  const p = planted.P2;
  const [a, b] = p.use_cases;
  it('the two top picks conflict', () => {
    expect(conflicts(a.top, b.top)).toBe(true);
  });
  it.each(p.use_cases.map((u) => [u.use_case, u] as const))('%s: findings, top pick, and near-miss line up', (_uc, u) => {
    expect(isStrongGap(finding(u.finding))).toBe(true);
    expect(solves(u.top, u.use_case)).toBe(true);
    expect(solves(u.near_miss, u.use_case)).toBe(true);
    const other = u === a ? b : a;
    expect(conflicts(u.near_miss, other.top)).toBe(false);
  });
});

describe('P3: EU data-residency finding with no matching ontology term', () => {
  const p = planted.P3;
  it('the finding exists and is a risk', () => {
    const f = finding(p.finding);
    expect(f.kind).toBe('risk');
    expect(String(f.text)).toMatch(/residen/i);
  });
  it('no core label or relationship type covers it', () => {
    expect(labelNames()).not.toContain(p.concept);
    expect([...labelNames(), ...relationshipTypes()].filter((n) => /residen/i.test(n))).toEqual([]);
  });
});

describe('P5: exactly one pattern variant has a task cycle', () => {
  const p = planted.P5;
  it('the planted pattern is cyclic and solves the use case of a Nimbus finding', () => {
    expect(hasCycle(patternTasks(p.pattern))).toBe(true);
    expect(solves(p.pattern, p.use_case)).toBe(true);
    finding(p.finding);
  });
  it('every other pattern is acyclic', () => {
    const cyclic = nodes(ds, 'Pattern')
      .map((n) => String(n.id))
      .filter((id) => hasCycle(patternTasks(id)));
    expect(cyclic).toEqual([p.pattern]);
  });
});

describe('P6: buy vs build inputs', () => {
  it.each(planted.P6.map((c) => [c.capability, c] as const))('%s', (_cap, c) => {
    const f = finding(c.finding);
    expect(f.kind).toBe('capability');
    expect(edges('IS_A', c.finding, c.capability).filter((r) => r.from.key.deal_code === 'nimbus')).toHaveLength(1);
    expect(solves(c.pattern, c.use_case)).toBe(true);

    const tasks = patternTasks(c.pattern);
    const total = tasks.reduce((s, t) => s + t.weeks_e, 0);
    const chain = tasks.filter((t) => t.deps.length === 0).length === 1 && tasks.every((t) => t.deps.length <= 1);
    expect(chain, `${c.pattern} is a linear chain, so total = critical path`).toBe(true);
    expect(total).toBeCloseTo(c.integrate_weeks, 5);

    const build = nodes(ds, 'BuildOption').find((o) => o.id === c.build_option)!;
    expect(edges('DELIVERS', c.build_option, c.capability)).toHaveLength(1);
    expect(Number(build.weeks_e)).toBeCloseTo(c.build_weeks, 5);

    const provides = edges('PROVIDES', c.platform_capability, c.capability);
    expect(provides).toHaveLength(1);
    expect(Number(provides[0]!.props.coverage)).toBeCloseTo(c.coverage, 5);

    if (c.expected === 'retire') expect(c.coverage).toBeGreaterThanOrEqual(0.8);
    if (c.expected === 'integrate') {
      expect(c.coverage).toBeLessThan(0.8);
      expect(c.build_weeks).toBeGreaterThanOrEqual(2 * c.integrate_weeks);
    }
    if (c.expected === 'review') {
      expect(c.coverage).toBeLessThan(0.8);
      expect(Math.abs(c.build_weeks - c.integrate_weeks) / c.build_weeks).toBeLessThanOrEqual(0.25);
    }
  });

  it('covers integrate, retire, and review exactly once each', () => {
    expect(planted.P6.map((c) => c.expected).sort()).toEqual(['integrate', 'retire', 'review']);
  });
});
