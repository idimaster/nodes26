import { describe, expect, it } from 'vitest';
import { cypherTemplate, templateNames, type TemplateName } from '@planner/engine';
import { validate, type GuardContext } from '../src/index.js';

/** Every standard write the skill uses must pass the guard as-is (and DELETE only via the exception). */

const ctx: GuardContext = {
  activeTerms: [],
  lookupGate: async (id) => (id === 'gd-ok' ? { deal_code: 'nimbus', iteration: 1, gate: 'commit', status: 'approved' } : null),
};

const SAMPLE: Record<TemplateName, Record<string, unknown>> = {
  set_deal_strategy: { deal: 'nimbus', strategy: 'bridge' },
  create_iteration: { deal: 'nimbus', n: 1, started_at: '2026-10-05T09:00:00Z' },
  classify_findings: { deal: 'nimbus', rows: [{ id: 'f-no-scim', classified_as: 'gap' }] },
  write_framed_use_cases: {
    deal: 'nimbus',
    iteration: 1,
    rows: [{ use_case_id: 'user-provisioning', framing_rationale: 'x', finding_ids: ['f-no-scim'] }],
  },
  write_candidates: {
    deal: 'nimbus',
    iteration: 1,
    rows: [{ uc: 'user-provisioning', pattern: 'scim-provisioning', fit_score: 72.3, band: 'recommend', signal_snapshot: '{}' }],
  },
  write_selections: {
    deal: 'nimbus',
    iteration: 1,
    rows: [{ uc: 'user-provisioning', pattern: 'scim-provisioning', fit_score: 72.3, rationale: 'x' }],
  },
  replace_selection: {
    deal: 'nimbus',
    iteration: 1,
    uc: 'ledger-data-sync',
    pattern: 'event-bus-bridge',
    fit_score: 84.4,
    rationale: 'Near-miss.',
  },
  write_plan_tasks: { deal: 'nimbus', iteration: 1 },
  commit_roadmap: { deal: 'nimbus', iteration: 1, version: 1, gate_id: 'gd-ok' },
  write_capability_decisions: {
    deal: 'nimbus',
    iteration: 1,
    rows: [{ capability_id: 'sso', outcome: 'integrate', integrate_effort: 6, build_effort: 20, coverage: 0.7, rule_version: 'bb1-v1' }],
  },
};

describe('cypher templates pass the guard', () => {
  it.each(templateNames())('%s', async (name) => {
    const d = await validate(cypherTemplate(name).query, SAMPLE[name], ctx);
    expect(d, d.allow ? '' : d.reason).toEqual({ allow: true });
  });

  it('a template whose free text mentions "committed" is not a G8 write (live-run false positive)', async () => {
    const rationale = 'Near-miss: the fast path cannot be committed, its tasks form a cycle (V3).';
    expect(await validate(cypherTemplate('replace_selection').query, { ...SAMPLE.replace_selection, rationale }, ctx)).toEqual({ allow: true });
    const rows = [{ uc: 'user-provisioning', pattern: 'scim-provisioning', fit_score: 72.3, rationale: 'Committed to SCIM by the architect.' }];
    expect(await validate(cypherTemplate('write_selections').query, { ...SAMPLE.write_selections, rows }, ctx)).toEqual({ allow: true });
  });

  it('commit_roadmap still needs gate_id: its query writes the committed literal', async () => {
    const noGate = Object.fromEntries(Object.entries(SAMPLE.commit_roadmap).filter(([k]) => k !== 'gate_id'));
    const d = await validate(cypherTemplate('commit_roadmap').query, noGate, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.violations.map((v) => v.rule)).toContain('G8');
  });

  it('a hand-written write still may not smuggle committed in through a param', async () => {
    const q = "MATCH (s:Selection {deal_code: $deal, iteration: $iteration}) SET s.status = substring($x, 4, 9) RETURN s.uc AS uc";
    const d = await validate(q, { deal: 'nimbus', iteration: 1, x: 'abc committed' }, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.violations.map((v) => v.rule)).toContain('G8');
  });

  it('commit_roadmap is denied without an approved commit gate', async () => {
    const d = await validate(cypherTemplate('commit_roadmap').query, { ...SAMPLE.commit_roadmap, gate_id: 'gd-none' }, ctx);
    expect(d.allow).toBe(false);
  });

  it('the destructive exception needs the exact template text', async () => {
    const q = cypherTemplate('replace_selection').query;
    const reformatted = q.replace(/\n/g, '\n  '); // whitespace-only change: still the template
    expect(await validate(reformatted, SAMPLE.replace_selection, ctx)).toEqual({ allow: true });
    const edited = q.replace("WHERE s.status = 'draft'", 'WHERE true');
    const d = await validate(edited, SAMPLE.replace_selection, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.violations.map((v) => v.rule)).toContain('G2');
  });

  it('the destructive exception needs params that pass the template schema', async () => {
    const d = await validate(cypherTemplate('replace_selection').query, { ...SAMPLE.replace_selection, extra: 1 }, ctx);
    expect(d.allow).toBe(false);
  });
});

describe('write_plan_tasks may set derived properties because it is the template', () => {
  it('passes as the exact template, and is denied once edited', async () => {
    const q = cypherTemplate('write_plan_tasks').query;
    expect(await validate(q, { deal: 'nimbus', iteration: 1 }, ctx)).toEqual({ allow: true });
    const edited = q.replace('pt.weeks_e = t.weeks_e', 'pt.weeks_e = 0.1');
    const d = await validate(edited, { deal: 'nimbus', iteration: 1 }, ctx);
    expect(d.allow).toBe(false);
  });
});
