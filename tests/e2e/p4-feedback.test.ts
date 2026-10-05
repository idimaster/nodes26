import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

/**
 * T4.1 acceptance, P4: the architect rejects a selection with a comment, iteration 2 re-plans from
 * memory, and iteration_diff lists the change with its feedback text. Over the real MCP servers.
 */

const DEAL = 'nimbus';
const COMMENT = 'Ledger sync must not read the production database log.\nremove cdc-replication';
let h: Harness;

beforeAll(async () => {
  h = await startHarness(DEAL);
}, 60_000);

afterAll(async () => {
  await h.close();
});

const frameAndSelect = async (iteration: number) => {
  await h.write('create_iteration', { deal: DEAL, n: iteration, started_at: '2026-10-05T09:00:00Z' });
  await h.write('write_framed_use_cases', {
    deal: DEAL,
    iteration,
    rows: [{ use_case_id: 'ledger-data-sync', framing_rationale: 'Framed from f-ledger-sync.', finding_ids: ['f-ledger-sync'] }],
  });
  const candidates = await h.read<{ id: string }>('candidates', { use_case: 'ledger-data-sync' });
  const findings = await h.read<{ id: string; text: string; target_company: string; acquirer: string }>('findings');
  const ranked = (await h.call('planner-engine', 'analyze_pattern_fit', {
    use_case: {
      use_case_id: 'ledger-data-sync',
      description: "The target's ledger postings reach the acquirer's finance systems within minutes.",
      finding_texts: [findings.find((f) => f.id === 'f-ledger-sync')?.text ?? ''],
    },
    deal_context: { strategy: 'bridge', target_company: findings[0]?.target_company, acquirer: findings[0]?.acquirer, selected_patterns: [] },
    candidates,
  })) as { pattern: string; score: number; band: string; signals: unknown }[];
  await h.write('write_candidates', {
    deal: DEAL,
    iteration,
    rows: ranked.map((r) => ({ uc: 'ledger-data-sync', pattern: r.pattern, fit_score: r.score, band: r.band, signal_snapshot: JSON.stringify(r.signals) })),
  });
  const top = ranked[0] as { pattern: string; score: number };
  await h.write('write_selections', { deal: DEAL, iteration, rows: [{ uc: 'ledger-data-sync', pattern: top.pattern, fit_score: top.score, rationale: 'Top pick.' }] });
  return { candidates: candidates.map((c) => c.id), pick: top.pattern };
};

describe('P4: rejection → iteration 2 → the diff explains the change', () => {
  it('re-plans from the architect’s feedback and resolves it', async () => {
    // Iteration 1: the top pick is cdc-replication; the architect rejects it at the select gate.
    const first = await frameAndSelect(1);
    expect(first).toEqual({ candidates: ['cdc-replication', 'event-bus-bridge'], pick: 'cdc-replication' });
    const rejected = await h.gate('select', 1, ['Selection:ledger-data-sync'], 'ledger-data-sync: cdc-replication', { action: 'reject', comment: COMMENT });
    expect(rejected).toMatchObject({
      status: 'rejected',
      feedback_ids: ['fb-gd-nimbus-1-select-1'],
      overrides: [{ kind: 'exclude_pattern', subject: 'cdc-replication' }],
    });

    // Step 13: recall memory.
    const [memory] = await h.read<{ latest_iteration: number; open_feedback: { id: string; text: string; about: string[] }[]; overrides: { kind: string; subject: string }[] }>(
      'recall_memory',
    );
    expect(memory?.latest_iteration).toBe(1);
    expect(memory?.open_feedback).toEqual([
      expect.objectContaining({ id: 'fb-gd-nimbus-1-select-1', text: COMMENT, about: ['Selection:ledger-data-sync -> cdc-replication'] }),
    ]);
    expect(memory?.overrides).toEqual([expect.objectContaining({ kind: 'exclude_pattern', subject: 'cdc-replication' })]);

    // Iteration 2: retrieval no longer offers the excluded pattern.
    const second = await frameAndSelect(2);
    expect(second).toEqual({ candidates: ['event-bus-bridge'], pick: 'event-bus-bridge' });
    expect(
      await h.call('gate', 'resolve_feedback', {
        deal: DEAL,
        iteration: 2,
        feedback_id: 'fb-gd-nimbus-1-select-1',
        resolved_by_ids: ['Selection:ledger-data-sync'],
      }),
    ).toMatchObject({ status: 'resolved' });

    // The diff lists the change, with its feedback text.
    expect(await h.read('iteration_diff', { iteration: 2 })).toEqual([
      { uc: 'ledger-data-sync', change: 'changed', before: 'cdc-replication', after: 'event-bus-bridge', feedback: [COMMENT] },
    ]);
    // And nothing is remembered as open any more.
    const [after] = await h.read<{ open_feedback: unknown[] }>('recall_memory');
    expect(after?.open_feedback).toEqual([]);

    // The re-plan is approved at the next select gate.
    expect((await h.gate('select', 2, ['Selection:ledger-data-sync'], 'ledger-data-sync: event-bus-bridge (resolves the feedback)')).status).toBe(
      'approved',
    );
  }, 120_000);
});
