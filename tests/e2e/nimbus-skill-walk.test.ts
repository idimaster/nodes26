import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUERIES, SKILL, startHarness, type Harness } from './harness.js';

/**
 * T2.6, without an LLM: walk the plan-integration skill for Nimbus through the real MCP servers,
 * with the skill's own named queries, every write checked by the guard first, and gates approved in
 * the console over HTTP. The LLM's choices (framing, picking the top candidate) are fixed here.
 */

const DEAL = 'nimbus';
let h: Harness;
let driver: Driver;
const call = (server: string, tool: string, args: Record<string, unknown>) => h.call(server, tool, args);
const read = <T = Record<string, unknown>>(name: string, params: Record<string, unknown> = {}) => h.read<T>(name, params);
const write = (template: string, params: Record<string, unknown>) => h.write(template, params);
const gate = async (kind: string, iteration: number, subjects: string[], summary: string) => (await h.gate(kind, iteration, subjects, summary)).gate_id;

beforeAll(async () => {
  h = await startHarness(DEAL);
  driver = h.driver;
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('the plan-integration skill, walked for Nimbus (T2.6)', () => {
  it('has every named query the steps refer to', () => {
    for (const q of ['findings', 'coverage', 'next_iteration', 'use_cases', 'candidates', 'pattern_tasks', 'prior_estimates', 'bb1', 'near_miss', 'derive_prerequisite', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v6b', 'next_roadmap_version']) {
      expect(QUERIES[q], q).toBeTruthy();
      expect(SKILL).toContain(`\`${q}\``);
    }
  });

  it('reaches a committed roadmap', async () => {
    // 1. Ground
    expect(JSON.stringify(await call('neo4j-read', 'get-schema', {}))).toContain('Finding');
    const findings = await read<{ id: string; kind: string; text: string; severity: string; confidence: number; evidence_type: string; capability_type: string | null; target_company: string; acquirer: string }>('findings');
    expect(findings.length).toBe(25);
    const coverage = Object.fromEntries((await read<{ capability_type: string; coverage: number }>('coverage')).map((c) => [c.capability_type, c.coverage]));
    const [{ n: iteration }] = (await read<{ n: number }>('next_iteration')) as [{ n: number }];
    expect(iteration).toBe(1);

    // 2. Classify
    const classified = (await call('planner-engine', 'classify_finding', { findings })) as { id: string; classified_as: string }[];
    expect(Number((await write('classify_findings', { deal: DEAL, rows: classified })).classified)).toBe(25);

    // 3. Strategy
    const byId = new Map(classified.map((c) => [c.id, c.classified_as]));
    const [strategy] = (await call('planner-engine', 'recommend_strategy', {
      findings: findings.map((f) => ({ id: f.id, kind: byId.get(f.id), severity: f.severity, ...(f.capability_type ? { capability_type: f.capability_type } : {}) })),
      coverage,
    })) as { strategy: string; fit_score: number; rationale: string }[];
    expect(strategy?.strategy).toBe('bridge');

    // 4. Frame (the LLM's choice, fixed here). ledger-data-sync and reporting-consolidation plant P2;
    // container-platform-migration (from the VM-hosting finding) plants P5.
    await write('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
    const framings = [
      { use_case_id: 'user-provisioning', finding_ids: ['f-no-scim'] },
      { use_case_id: 'ledger-data-sync', finding_ids: ['f-ledger-sync'] },
      { use_case_id: 'reporting-consolidation', finding_ids: ['f-reporting'] },
      { use_case_id: 'customer-sso', finding_ids: ['f-customer-sso'] },
      { use_case_id: 'audit-logging', finding_ids: ['f-audit-store'] },
      { use_case_id: 'container-platform-migration', finding_ids: ['f-vm-hosting'] },
    ];
    const frame = async (rows: { use_case_id: string; finding_ids: string[]; framing_rationale?: string }[]) => {
      const out = await write('write_framed_use_cases', {
        deal: DEAL,
        iteration,
        rows: rows.map((f) => ({ framing_rationale: `Framed from ${f.finding_ids.join(', ')}.`, ...f })),
      });
      expect(Number(out.framed)).toBe(rows.length);
    };
    await frame(framings);
    await gate('frame', iteration, framings.map((f) => `FramedUseCase:${f.use_case_id}`), `Strategy ${strategy?.strategy} (${strategy?.fit_score}).`);
    await write('set_deal_strategy', { deal: DEAL, strategy: strategy?.strategy });

    // 5. Retrieve and score
    const useCases = new Map((await read<{ id: string; description: string }>('use_cases')).map((u) => [u.id, u.description]));
    const score = async (uc: string, findingIds: string[], selectedPatterns: string[]) => {
      const candidates = await read('candidates', { use_case: uc });
      const ranked = (await call('planner-engine', 'analyze_pattern_fit', {
        use_case: { use_case_id: uc, description: useCases.get(uc), finding_texts: findingIds.map((id) => findings.find((x) => x.id === id)?.text ?? '') },
        deal_context: { strategy: strategy?.strategy, target_company: findings[0]?.target_company, acquirer: findings[0]?.acquirer, selected_patterns: selectedPatterns },
        candidates,
      })) as { pattern: string; score: number; band: string; signals: unknown }[];
      const rows = ranked.slice(0, 3).map((r) => ({ uc, pattern: r.pattern, fit_score: r.score, band: r.band, signal_snapshot: JSON.stringify(r.signals) }));
      expect(Number((await write('write_candidates', { deal: DEAL, iteration, rows })).candidates)).toBe(rows.length);
      return ranked;
    };
    const top = new Map<string, { pattern: string; score: number }>();
    for (const f of framings) {
      const ranked = await score(f.use_case_id, f.finding_ids, []);
      top.set(f.use_case_id, { pattern: ranked[0]?.pattern as string, score: ranked[0]?.score as number });
    }
    expect(top.get('user-provisioning')?.pattern).toBe('scim-provisioning');
    expect(top.get('ledger-data-sync')?.pattern).toBe('cdc-replication');
    expect(top.get('reporting-consolidation')?.pattern).toBe('batch-etl-export');
    expect(top.get('container-platform-migration')?.pattern).toBe('container-replatform-fastpath');

    // 6. Select (the LLM takes the top candidate) and the select gate
    const selections = [...top].map(([uc, t]) => ({ uc, pattern: t.pattern, fit_score: t.score, rationale: 'Highest fit score.' }));
    expect(Number((await write('write_selections', { deal: DEAL, iteration, rows: selections })).selections)).toBe(selections.length);
    await gate('select', iteration, selections.map((s) => `Selection:${s.uc}`), selections.map((s) => `${s.uc}: ${s.pattern} (${s.fit_score})`).join('; '));

    // 7. Instantiate: the graph derives tasks and edges from the catalog
    await write('write_plan_tasks', { deal: DEAL, iteration });

    // 8. Validate, and repair as the skill says (at most two rounds)
    type Check = { check: string; verdict: string; violations: { witness: string[]; detail: string }[] };
    const validate = async () => {
      const out: Record<string, Check> = {};
      for (const q of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v6b']) {
        const [row] = await read<Check>(q, { iteration });
        out[(row as Check).check] = row as Check;
      }
      return out;
    };
    const repairs: string[] = [];
    let checks = await validate();
    // P1 and P2 as planted: scim-provisioning and oidc-broker need idp-trust-establishment; cdc and batch conflict.
    expect(checks.V1?.violations.map((v) => v.witness)).toEqual([
      ['oidc-broker', 'idp-trust-establishment'],
      ['scim-provisioning', 'idp-trust-establishment'],
    ]);
    expect(checks.V2?.violations.map((v) => v.witness)).toEqual([['batch-etl-export', 'cdc-replication']]);
    // P5: the fast path's catalog tasks form a cycle; the witness names the selection before ':'.
    expect(checks.V3?.verdict).toBe('FAIL');
    expect(new Set(checks.V3?.violations.flatMap((v) => v.witness.map((id) => id.slice(0, id.indexOf(':')))))).toEqual(new Set(['container-platform-migration']));
    for (let round = 0; round < 2 && Object.values(checks).some((c) => c.verdict.startsWith('FAIL')); round++) {
      // V3: a cycle inside one selection comes from its catalog pattern; switch that use case to its near-miss.
      for (const uc of new Set((checks.V3?.violations ?? []).flatMap((v) => v.witness.map((id) => id.slice(0, id.indexOf(':')))))) {
        const [nm] = await read<{ pattern: string; fit_score: number; current: string }>('near_miss', { iteration, uc });
        expect(nm, `a near-miss for ${uc}`).toBeDefined();
        await write('replace_selection', {
          deal: DEAL, iteration, uc, pattern: nm?.pattern, fit_score: nm?.fit_score,
          rationale: `Near-miss: ${nm?.current} tasks form a cycle (V3).`,
        });
        repairs.push(`V3: ${uc} → ${nm?.pattern}`);
      }
      // V2: switch the use case that loses fewer points to its stored near-miss.
      for (const v of checks.V2?.violations ?? []) {
        const ucs = [...v.detail.matchAll(/(\S+) selects/g), ...v.detail.matchAll(/selected for (\S+)/g)].map((m) => m[1] as string);
        const options = [];
        for (const uc of ucs) {
          const [nm] = await read<{ pattern: string; fit_score: number; points_lost: number }>('near_miss', { iteration, uc });
          if (nm) options.push({ uc, ...nm });
        }
        const best = options.sort((a, b) => a.points_lost - b.points_lost)[0];
        expect(best).toBeDefined();
        await write('replace_selection', {
          deal: DEAL, iteration, uc: best?.uc, pattern: best?.pattern, fit_score: best?.fit_score,
          rationale: `Near-miss: ${v.witness.join(' CONFLICTS with ')} (V2).`,
        });
        repairs.push(`V2: ${best?.uc} → ${best?.pattern}`);
      }
      // V1: derive each missing prerequisite once.
      const derived = new Set<string>();
      for (const v of (checks.V1?.violations ?? []).filter((x) => x.witness.length === 2)) {
        const missing = v.witness.at(-1) as string;
        if (derived.has(missing)) continue;
        derived.add(missing);
        const [d] = await read<{ finding_ids: string[]; use_cases: string[] }>('derive_prerequisite', { iteration, required_by: v.witness[0], missing });
        const uc = d?.use_cases[0] as string;
        expect(uc, `a use case for ${missing}`).toBeDefined();
        await frame([{ use_case_id: uc, finding_ids: d?.finding_ids ?? [], framing_rationale: `Required by ${v.witness[0]} (V1).` }]);
        const current = (await driver.executeQuery('MATCH (s:Selection {deal_code: $deal, iteration: 1}) RETURN s.pattern AS p', { deal: DEAL })).records.map(
          (r) => r.get('p') as string,
        );
        const ranked = await score(uc, d?.finding_ids ?? [], current);
        const pick = ranked.find((r) => r.pattern === missing);
        await write('write_selections', { deal: DEAL, iteration, rows: [{ uc, pattern: missing, fit_score: pick?.score ?? 0, rationale: `Required by ${v.witness[0]} (V1).` }] });
        repairs.push(`V1: derived ${missing} for ${uc}`);
      }
      await write('write_plan_tasks', { deal: DEAL, iteration });
      checks = await validate();
    }
    expect(repairs).toEqual([
      'V3: container-platform-migration → container-replatform',
      'V2: ledger-data-sync → event-bus-bridge',
      'V1: derived idp-trust-establishment for identity-federation-trust',
      // the near-miss needs its own prerequisite, derived in the second round
      'V1: derived landing-zone-onboarding for cloud-account-consolidation',
    ]);
    for (const c of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']) expect(checks[c]?.verdict, c).toBe('PASS');
    expect(['PASS', 'WARN']).toContain(checks.V6b?.verdict);

    // 9. Schedule: the graph does it (planner-graph), the agent only asks
    const schedule = (await call('planner-graph', 'schedule_plan', { deal: DEAL, iteration })) as {
      status: string;
      engine: string;
      tasks: number;
      finish: number;
      critical_path: string[];
      pert: { p10: number; p90: number };
    };
    expect(schedule).toMatchObject({ status: 'scheduled', engine: 'gds' });
    const unscheduled = await driver.executeQuery(
      'MATCH (pt:PlanTask {deal_code: $deal, iteration: 1}) WHERE pt.earliest_start IS NULL OR pt.wave IS NULL RETURN count(pt) AS n',
      { deal: DEAL },
    );
    expect(Number(unscheduled.records[0]?.get('n'))).toBe(0);

    // 10. Commit: explain the critical-path estimates first (T3.5)
    const criticalTasks = [...new Set(schedule.critical_path.map((id) => id.slice(id.indexOf(':') + 1)))];
    const priors = await read<{ task_id: string; weeks_o: number; weeks_e: number; weeks_p: number; observations: number[] }>('prior_estimates', {
      task_ids: criticalTasks,
    });
    expect(priors).toHaveLength(criticalTasks.length);
    const provenance = [];
    for (const p of priors) {
      provenance.push(
        (await call('planner-engine', 'estimate_provenance', {
          task: { id: p.task_id, weeks_o: p.weeks_o, weeks_e: p.weeks_e, weeks_p: p.weeks_p },
          observations: p.observations,
          modifiers: [],
        })) as { task_id: string; baseline: number; n: number; result: number },
      );
    }
    expect(provenance.every((x) => x.result > 0 && x.baseline > 0)).toBe(true);

    const finalSelections = (await driver.executeQuery(
      'MATCH (s:Selection {deal_code: $deal, iteration: 1}) RETURN s.uc AS uc ORDER BY uc',
      { deal: DEAL },
    )).records.map((r) => r.get('uc') as string);
    expect(finalSelections).toHaveLength(8);
    const [{ version }] = (await read<{ version: number }>('next_roadmap_version')) as [{ version: number }];
    const commitGate = await gate(
      'commit',
      iteration,
      [...finalSelections.map((uc) => `Selection:${uc}`), `Iteration:${iteration}`],
      `Finish week ${schedule.finish}; PERT ${schedule.pert.p10}–${schedule.pert.p90}; repairs: ${repairs.join('; ')}.`,
    );
    const committed = await write('commit_roadmap', { deal: DEAL, iteration, version, gate_id: commitGate });
    expect(Number(committed.included)).toBe(finalSelections.length);

    // 11. Buy vs build (T3.6): SSO and audit logging are planned, the billing ledger is not.
    type BB1Row = { capability_id: string; integrate_effort: number | null; build_effort: number | null; coverage: number };
    const rows = (await read<BB1Row>('bb1', { iteration })).filter((r) => r.build_effort !== null);
    const bb = (await call('planner-engine', 'classify_buy_build', { rows })) as {
      rule_version: string;
      outcomes: { capability_id: string; outcome: string; integrate_effort: number; build_effort: number; coverage: number }[];
      unplanned: string[];
    };
    expect(bb.outcomes.map((o) => [o.capability_id, o.outcome])).toEqual([
      ['audit-logging', 'retire'],
      ['sso', 'integrate'],
    ]);
    expect(bb.unplanned).toEqual(['billing-ledger']);
    const decided = await write('write_capability_decisions', {
      deal: DEAL,
      iteration,
      rows: bb.outcomes.map((o) => ({
        capability_id: o.capability_id,
        outcome: o.outcome,
        integrate_effort: o.integrate_effort,
        build_effort: o.build_effort,
        coverage: o.coverage,
        rule_version: bb.rule_version,
      })),
    });
    expect(Number(decided.decisions)).toBe(2);

    // The record: a committed roadmap backed by an approved commit gate, and nothing left in draft.
    const { records } = await driver.executeQuery(
      `MATCH (r:Roadmap {deal_code: $deal, version: 1})-[:INCLUDES]->(s:Selection)
       MATCH (g:GateDecision {id: r.gate_id})
       RETURN r.status AS roadmap, g.gate AS gate, g.status AS gate_status, collect(DISTINCT s.status) AS selections,
              COUNT { MATCH (n {deal_code: $deal, iteration: 1}) WHERE n.status = 'draft' RETURN n } AS drafts`,
      { deal: DEAL },
    );
    expect(records[0]?.toObject()).toEqual({
      roadmap: 'committed',
      gate: 'commit',
      gate_status: 'approved',
      selections: ['committed'],
      drafts: expect.objectContaining({ low: 0 }),
    });
  }, 120_000);
});
