import { describe, expect, it } from 'vitest';
import raw from '../../config/thresholds.json' with { type: 'json' };
import { nodes, readDataset, readPlanted, relationships, type Dataset } from '@planner/data';
import {
  analyzePatternFit,
  classifyBuyBuild,
  classifyFinding,
  computeSchedule,
  CycleError,
  instantiateTasks,
  recommendStrategy,
  thresholdsSchema,
  type FitCandidate,
  type SelectionInput,
} from '@planner/engine';

/** Engine behavior on the real demo data (T2.1 acceptance). No Neo4j: inputs are built from @planner/data. */

const TH = thresholdsSchema.parse(raw);
const ds: Dataset = readDataset();
const planted = readPlanted();

const ids = (type: string, from: string) =>
  relationships(ds, type)
    .filter((r) => r.from.key.id === from)
    .map((r) => String(r.to.key.id));
const nimbus = nodes(ds, 'Deal').find((d) => d.code === 'nimbus')!;
const finding = (id: string) => nodes(ds, 'Finding').find((f) => f.deal_code === 'nimbus' && f.id === id)!;
const pattern = (id: string) => nodes(ds, 'Pattern').find((p) => p.id === id)!;

function candidate(id: string): FitCandidate {
  const p = pattern(id);
  return {
    id,
    name: String(p.name),
    description: String(p.description),
    solves: ids('SOLVES', id),
    strategies: ids('APPLIES_TO', id),
    requires: ids('REQUIRES', id),
    not_recommended_when: (p.not_recommended_when as string[] | undefined) ?? [],
  };
}

function fit(useCase: string, findingIds: string[], strategy = 'bridge') {
  const uc = nodes(ds, 'UseCase').find((u) => u.id === useCase)!;
  const solvers = relationships(ds, 'SOLVES')
    .filter((r) => r.to.key.id === useCase)
    .map((r) => String(r.from.key.id));
  return analyzePatternFit(
    {
      use_case: {
        use_case_id: useCase,
        description: String(uc.description),
        finding_texts: findingIds.map((f) => String(finding(f).text)),
      },
      deal_context: {
        strategy,
        target_company: String(nimbus.target_company),
        acquirer: String(nimbus.acquirer),
        selected_patterns: [],
      },
      candidates: solvers.map(candidate),
    },
    TH,
  );
}

function selection(uc: string, patternId: string): SelectionInput {
  return {
    uc,
    pattern: patternId,
    requires: ids('REQUIRES', patternId),
    tasks: ids('HAS_TASK', patternId).map((taskId) => {
      const t = nodes(ds, 'Task').find((x) => x.id === taskId)!;
      return {
        id: taskId,
        weeks_o: Number(t.weeks_o),
        weeks_e: Number(t.weeks_e),
        weeks_p: Number(t.weeks_p),
        skill: String(t.skill),
        depends_on: relationships(ds, 'DEPENDS_ON')
          .filter((r) => r.from.label === 'Task' && r.from.key.id === taskId)
          .map((r) => String(r.to.key.id)),
      };
    }),
  };
}

describe('recommend_strategy on Nimbus', () => {
  it('recommends bridge', () => {
    const coverage = Object.fromEntries(
      relationships(ds, 'PROVIDES').map((r) => [String(r.to.key.id), Number(r.props.coverage)]),
    );
    const findings = nodes(ds, 'Finding')
      .filter((f) => f.deal_code === 'nimbus')
      .map((f) => {
        const isA = relationships(ds, 'IS_A').find((r) => r.from.key.deal_code === 'nimbus' && r.from.key.id === f.id);
        return {
          id: String(f.id),
          kind: classifyFinding(
            { id: String(f.id), kind: String(f.kind), evidence_type: String(f.evidence_type), confidence: Number(f.confidence) },
            TH,
          ),
          severity: String(f.severity),
          ...(isA ? { capability_type: String(isA.to.key.id) } : {}),
        };
      });
    const [top, other] = recommendStrategy({ findings, coverage }, TH);
    expect(top?.strategy).toBe('bridge');
    expect(top!.fit_score).toBeGreaterThan(other!.fit_score);
    expect(top?.finding_ids).toContain(planted.P3.finding); // the EU residency risk argues for bridge
  });
});

describe('analyze_pattern_fit on the planted situations', () => {
  it('P1: ranks the pattern that REQUIRES the unselected federation pattern first', () => {
    const ranked = fit(planted.P1.use_case, [planted.P1.finding]);
    expect(ranked[0]?.pattern).toBe(planted.P1.pattern);
    expect(ranked[0]?.band).toBe('recommend');
  });

  it.each(planted.P2.use_cases.map((u) => [u.use_case, u] as const))(
    'P2: %s ranks the conflicting top pick first, with the near-miss within 20 points',
    (_uc, u) => {
      const ranked = fit(u.use_case, [u.finding]);
      expect(ranked[0]?.pattern).toBe(u.top);
      const nearMiss = ranked.find((r) => r.pattern === u.near_miss);
      expect(nearMiss).toBeDefined();
      expect(ranked[0]!.score - nearMiss!.score).toBeLessThanOrEqual(20);
    },
  );

  it('P5: ranks the cyclic fast-path variant first under bridge', () => {
    expect(fit(planted.P5.use_case, [planted.P5.finding])[0]?.pattern).toBe(planted.P5.pattern);
  });
});

describe('compute_schedule on the planted cycle (P5)', () => {
  it('refuses to schedule and returns the cycle witness', () => {
    const { plan_tasks, depends_on } = instantiateTasks({
      deal: 'nimbus',
      iteration: 1,
      selections: [selection(planted.P5.use_case, planted.P5.pattern)],
    });
    const prefix = `${planted.P5.use_case}:${planted.P5.pattern}.`;
    expect(() => computeSchedule(plan_tasks, depends_on)).toThrow(
      expect.objectContaining({
        name: 'CycleError',
        witness: [`${prefix}cluster-onboarding`, `${prefix}deploy-manifests`, `${prefix}image-build`, `${prefix}cluster-onboarding`],
      }),
    );
    expect(() => computeSchedule(plan_tasks, depends_on)).toThrow(CycleError);
  });
});

describe('classify_buy_build on P6', () => {
  it('gives the outcomes in planted.yaml', () => {
    const rows = planted.P6.map((c) => {
      const { plan_tasks } = instantiateTasks({ deal: 'nimbus', iteration: 1, selections: [selection(c.use_case, c.pattern)] });
      const build = nodes(ds, 'BuildOption').find((b) => b.id === c.build_option)!;
      const provides = relationships(ds, 'PROVIDES').find((r) => r.to.key.id === c.capability);
      return {
        capability_id: c.capability,
        integrate_effort: plan_tasks.reduce((s, t) => s + t.weeks_e, 0),
        build_effort: Number(build.weeks_e),
        coverage: Number(provides?.props.coverage ?? 0),
      };
    });
    const { outcomes } = classifyBuyBuild(rows, TH);
    expect(outcomes.map((o) => [o.capability_id, o.outcome])).toEqual(planted.P6.map((c) => [c.capability, c.expected]));
  });
});

describe('instantiate_tasks + compute_schedule reproduce the history plans', () => {
  it.each(['tidewater', 'quarry'])('%s', (deal) => {
    const sels = nodes(ds, 'Selection')
      .filter((s) => s.deal_code === deal)
      .map((s) => selection(String(s.uc), String(s.pattern)));
    const { plan_tasks, depends_on } = instantiateTasks({ deal, iteration: 1, selections: sels });

    const stored = nodes(ds, 'PlanTask').filter((t) => t.deal_code === deal);
    expect(plan_tasks.map((t) => t.id).sort()).toEqual(stored.map((t) => String(t.id)).sort());
    const storedEdges = relationships(ds, 'DEPENDS_ON')
      .filter((r) => r.from.label === 'PlanTask' && r.from.key.deal_code === deal)
      .map((r) => `${String(r.from.key.id)}->${String(r.to.key.id)}`);
    expect(depends_on.map((e) => `${e.from}->${e.to}`).sort()).toEqual(storedEdges.sort());

    const schedule = computeSchedule(plan_tasks, depends_on);
    for (const t of schedule.tasks) {
      const s = stored.find((x) => x.id === t.id)!;
      expect({ es: t.earliest_start, wave: t.wave, critical: t.on_critical_path }, t.id).toEqual({
        es: s.earliest_start,
        wave: s.wave,
        critical: s.on_critical_path,
      });
    }
  });
});
