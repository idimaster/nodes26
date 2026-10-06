import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

/**
 * P5 end to end, over the real MCP servers: the VM-hosting finding frames container-platform-migration,
 * whose top bridge candidate is the planted cyclic fast path. V3 reports the cycle and scheduling refuses;
 * the skill's V3 repair switches the use case to its near-miss, after which the plan schedules.
 */

const DEAL = 'nimbus';
const UC = 'container-platform-migration';
let h: Harness;

beforeAll(async () => {
  h = await startHarness(DEAL);
}, 60_000);

afterAll(async () => {
  await h.close();
});

type Check = { check: string; verdict: string; violations: { witness: string[]; detail: string }[] };

describe('P5: a catalog pattern whose tasks form a cycle', () => {
  it('is caught by V3 and scheduling, then repaired with the near-miss', async () => {
    await h.write('create_iteration', { deal: DEAL, n: 1, started_at: '2026-10-05T09:00:00Z' });
    await h.write('write_framed_use_cases', {
      deal: DEAL,
      iteration: 1,
      rows: [{ use_case_id: UC, framing_rationale: 'Framed from f-vm-hosting.', finding_ids: ['f-vm-hosting'] }],
    });
    const findings = await h.read<{ id: string; text: string; target_company: string; acquirer: string }>('findings');
    const useCases = new Map((await h.read<{ id: string; description: string }>('use_cases')).map((u) => [u.id, u.description]));
    const ranked = (await h.call('planner-engine', 'analyze_pattern_fit', {
      use_case: { use_case_id: UC, description: useCases.get(UC), finding_texts: [findings.find((f) => f.id === 'f-vm-hosting')?.text ?? ''] },
      deal_context: { strategy: 'bridge', target_company: findings[0]?.target_company, acquirer: findings[0]?.acquirer, selected_patterns: [] },
      candidates: await h.read('candidates', { use_case: UC }),
    })) as { pattern: string; score: number; band: string; signals: unknown }[];
    expect(ranked.map((r) => r.pattern)).toEqual(['container-replatform-fastpath', 'container-replatform']);
    await h.write('write_candidates', {
      deal: DEAL,
      iteration: 1,
      rows: ranked.map((r) => ({ uc: UC, pattern: r.pattern, fit_score: r.score, band: r.band, signal_snapshot: JSON.stringify(r.signals) })),
    });
    const top = ranked[0] as { pattern: string; score: number };
    await h.write('write_selections', { deal: DEAL, iteration: 1, rows: [{ uc: UC, pattern: top.pattern, fit_score: top.score, rationale: 'Highest fit score.' }] });
    await h.write('write_plan_tasks', { deal: DEAL, iteration: 1 });

    // V3 reports the cycle; its witness names the selection (the use case before ':'); scheduling refuses.
    const [v3] = await h.read<Check>('v3', { iteration: 1 });
    expect(v3?.verdict).toBe('FAIL');
    const witness = v3?.violations[0]?.witness ?? [];
    expect(new Set(witness.map((id) => id.slice(0, id.indexOf(':'))))).toEqual(new Set([UC]));
    expect(await h.call('planner-graph', 'schedule_plan', { deal: DEAL, iteration: 1 })).toMatchObject({ status: 'cycle' });

    // The repair: the near-miss, with a rationale naming the cycle.
    const [nm] = await h.read<{ pattern: string; fit_score: number }>('near_miss', { iteration: 1, uc: UC });
    expect(nm?.pattern).toBe('container-replatform');
    expect(
      await h.write('replace_selection', {
        deal: DEAL, iteration: 1, uc: UC, pattern: nm?.pattern, fit_score: nm?.fit_score,
        rationale: 'Near-miss: container-replatform-fastpath tasks form a cycle (V3).',
      }),
    ).toMatchObject({ uc: UC, pattern: 'container-replatform' });
    await h.write('write_plan_tasks', { deal: DEAL, iteration: 1 });
    const [after] = await h.read<Check>('v3', { iteration: 1 });
    expect(after?.verdict).toBe('PASS');
    expect(await h.call('planner-graph', 'schedule_plan', { deal: DEAL, iteration: 1 })).toMatchObject({ status: 'scheduled' });
  }, 120_000);
});
