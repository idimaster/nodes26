import { computeSchedule, instantiateTasks } from '@planner/engine';
import type { z } from 'zod';
import type { evidenceType, findingKind } from './authoring.js';
import { DATA_DIR, GENERATED, readCatalog, readDataset, readHistorySpec } from './io.js';
import { manifestOf } from './metrics.js';
import { dealRef, ref, taskId, type Catalog } from './normalize.js';
import { between, pick, rng, round, shuffle } from './rng.js';
import { addNode, addRel, emptyDataset, must, type Dataset, type NodeRef } from './types.js';

/** Fixed seed (DATA.md). Changing it changes every generated number in the talk. */
export const SEED = 2026;

const FILLER_COUNT = 11;

interface Template {
  kind: z.infer<typeof findingKind>;
  text: string;
  is_a?: string;
}

/** Filler Nimbus findings. Never critical: the only critical gap is planted (P1), so V4 stays focused. */
const FILLER_TEMPLATES: Template[] = [
  { kind: 'capability', text: 'Nimbus runs its own API gateway in front of public endpoints, with per-tenant rate limits.', is_a: 'api-gateway' },
  { kind: 'capability', text: 'Nimbus ships application metrics and traces to a self-hosted observability stack.', is_a: 'observability' },
  { kind: 'capability', text: 'Nimbus keeps secrets for its newest services in a self-hosted vault.', is_a: 'secrets-management' },
  { kind: 'capability', text: 'Nimbus maintains a small reporting warehouse fed by nightly batch jobs.', is_a: 'data-warehouse' },
  { kind: 'gap', text: 'There is no documented API deprecation policy; old endpoint versions are kept indefinitely.' },
  { kind: 'gap', text: 'Customer webhooks are delivered without retries or payload signing.' },
  { kind: 'gap', text: 'Production infrastructure is defined partly in scripts and partly by hand; configuration drift is common.' },
  { kind: 'gap', text: 'Backups run nightly, but no restore has been tested in the last year.' },
  { kind: 'gap', text: 'There is no central on-call rotation; incidents are handled by whoever notices first.' },
  { kind: 'gap', text: 'Admin console sessions stay valid for 30 days without re-authentication.' },
  { kind: 'risk', text: 'Two senior engineers hold most of the knowledge of the ledger reconciliation code.' },
  { kind: 'risk', text: 'An invoice-capture OCR component is licensed per server, not per tenant.' },
  { kind: 'risk', text: 'The primary database runs a major version that leaves vendor support next year.' },
  { kind: 'assumption', text: 'Customer churn is assumed to stay flat through the integration.' },
  { kind: 'assumption', text: 'Nimbus customers are assumed to accept a login-page change with one month of notice.' },
  { kind: 'assumption', text: "Finance assumes Nimbus revenue-recognition rules already match Harborline's." },
];

const EVIDENCE: z.infer<typeof evidenceType>[] = ['code_inspection', 'vendor_docs', 'rfi', 'interview', 'assumption'];
const SOURCE_TYPE: Record<z.infer<typeof evidenceType>, string> = {
  code_inspection: 'code_repo',
  vendor_docs: 'vendor_doc',
  rfi: 'rfi_response',
  interview: 'interview_notes',
  assumption: 'interview_notes',
};

function nimbusFiller(r: () => number): Dataset {
  const ds = emptyDataset();
  const chosen = shuffle(r, FILLER_TEMPLATES).slice(0, FILLER_COUNT);
  chosen.forEach((t, i) => {
    const n = String(i + 1).padStart(2, '0');
    const id = `f-gen-${n}`;
    const sourceId = `s-gen-${n}`;
    const evidence = pick(r, EVIDENCE);
    addNode(ds, 'Source', {
      deal_code: 'nimbus',
      id: sourceId,
      type: SOURCE_TYPE[evidence],
      uri: `dataroom://nimbus/${SOURCE_TYPE[evidence]}/${sourceId}`,
    });
    addNode(ds, 'Finding', {
      deal_code: 'nimbus',
      id,
      kind: t.kind,
      text: t.text,
      severity: pick(r, ['low', 'medium', 'high'] as const),
      confidence: round(between(r, 0.4, 0.95), 2),
      evidence_type: evidence,
    });
    const f = dealRef('Finding', 'nimbus', id);
    addRel(ds, 'HAS_FINDING', { label: 'Deal', key: { code: 'nimbus' } }, f);
    addRel(ds, 'SUPPORTED_BY', f, dealRef('Source', 'nimbus', sourceId));
    if (t.is_a) addRel(ds, 'IS_A', f, ref('CapabilityType', t.is_a));
  });
  return ds;
}

const isoPlusWeeks = (start: string, weeks: number): string =>
  new Date(Date.parse(start) + weeks * 7 * 24 * 3600 * 1000).toISOString().replace('.000Z', 'Z');

/**
 * A completed integration: one committed iteration whose selections are instantiated into
 * PlanTasks (intra-pattern DEPENDS_ON, plus root tasks depending on the final tasks of every
 * selection whose pattern this one REQUIRES), scheduled per DESIGN §5.2, with jittered Actuals.
 */
function historyDeal(r: () => number, catalog: Catalog, d: ReturnType<typeof readHistorySpec>['deals'][number]): Dataset {
  const ds = emptyDataset();
  const deal = d.code;
  const it = 1;
  const patterns = new Map(catalog.patterns.map((p) => [p.id, p]));
  const dealNode: NodeRef = { label: 'Deal', key: { code: deal } };
  const iterRef: NodeRef = { label: 'Iteration', key: { deal_code: deal, n: it } };
  const planRef = (label: string, id: string): NodeRef => ({ label, key: { deal_code: deal, iteration: it, id } });

  addNode(ds, 'Deal', {
    code: deal,
    target_company: d.target_company,
    acquirer: d.acquirer,
    strategy: d.strategy,
    status: 'completed',
  });
  addNode(ds, 'Iteration', { deal_code: deal, n: it, started_at: d.started_at, status: 'committed' });
  addRel(ds, 'HAS_ITERATION', dealNode, iterRef);

  // PlanTasks and their dependencies come from the engine, exactly as in a live plan.
  const selections = d.selections.map((s) => {
    const p = patterns.get(s.pattern);
    if (!p) throw new Error(`history ${deal}: unknown pattern ${s.pattern}`);
    if (!p.solves.includes(s.use_case)) throw new Error(`history ${deal}: ${s.pattern} does not solve ${s.use_case}`);
    return {
      uc: s.use_case,
      pattern: p.id,
      requires: p.requires,
      tasks: p.tasks.map((t) => ({
        id: taskId(p.id, t.id),
        weeks_o: t.weeks[0],
        weeks_e: t.weeks[1],
        weeks_p: t.weeks[2],
        skill: t.skill,
        depends_on: t.depends_on.map((x) => taskId(p.id, x)),
      })),
    };
  });
  const { plan_tasks, depends_on } = instantiateTasks({ deal, iteration: it, selections });
  const schedule = new Map(computeSchedule(plan_tasks, depends_on).tasks.map((t) => [t.id, t]));

  const gateId = `gd-${deal}-commit-${it}`;
  addNode(ds, 'GateDecision', {
    id: gateId,
    deal_code: deal,
    iteration: it,
    gate: 'commit',
    status: 'approved',
    comment: '',
    by: 'architect',
    at: d.started_at,
  });
  const roadmapRef: NodeRef = { label: 'Roadmap', key: { deal_code: deal, version: 1 } };
  addNode(ds, 'Roadmap', { deal_code: deal, version: 1, iteration: it, status: 'committed', gate_id: gateId });
  addRel(ds, 'DECIDED_ON', ref('GateDecision', gateId), roadmapRef);

  for (const s of d.selections) {
    const fuc = planRef('FramedUseCase', s.use_case);
    const sel: NodeRef = { label: 'Selection', key: { deal_code: deal, iteration: it, uc: s.use_case } };
    addNode(ds, 'FramedUseCase', {
      deal_code: deal,
      iteration: it,
      id: s.use_case,
      framing_rationale: `Framed during the ${deal} integration.`,
      use_case_id: s.use_case,
    });
    addRel(ds, 'IN_ITERATION', fuc, iterRef);
    addRel(ds, 'INSTANCE_OF', fuc, ref('UseCase', s.use_case));
    addNode(ds, 'Selection', {
      deal_code: deal,
      iteration: it,
      uc: s.use_case,
      pattern: s.pattern,
      fit_score: round(between(r, 62, 88), 1),
      rationale: `Selected for ${s.use_case} in the ${deal} integration.`,
      status: 'committed',
    });
    addRel(ds, 'IN_ITERATION', sel, iterRef);
    addRel(ds, 'FOR', sel, fuc);
    addRel(ds, 'SELECTS', sel, ref('Pattern', s.pattern));
    addRel(ds, 'INCLUDES', roadmapRef, sel);

    for (const t of plan_tasks.filter((x) => x.uc === s.use_case)) {
      const f = must(schedule.get(t.id), `schedule for ${t.id}`);
      const pt = planRef('PlanTask', t.id);
      addNode(ds, 'PlanTask', {
        deal_code: deal,
        iteration: it,
        id: t.id,
        task_id: t.task_id,
        weeks_o: t.weeks_o,
        weeks_e: t.weeks_e,
        weeks_p: t.weeks_p,
        skill: t.skill,
        on_critical_path: f.on_critical_path,
        earliest_start: f.earliest_start,
        wave: f.wave,
      });
      addRel(ds, 'IN_ITERATION', pt, iterRef);
      addRel(ds, 'HAS_TASK', sel, pt);
      addRel(ds, 'INSTANTIATES', pt, ref('Task', t.task_id));
      for (const dep of depends_on.filter((e) => e.from === t.id)) addRel(ds, 'DEPENDS_ON', pt, planRef('PlanTask', dep.to));

      const weeksActual = round(t.weeks_e * between(r, 0.8, 1.5), 1);
      addNode(ds, 'Actual', {
        deal_code: deal,
        plan_task_id: t.id,
        task_id: t.task_id,
        weeks_actual: weeksActual,
        completed_at: isoPlusWeeks(d.started_at, f.earliest_start + weeksActual),
      });
      addRel(ds, 'OBSERVED_FOR', { label: 'Actual', key: { deal_code: deal, plan_task_id: t.id } }, pt);
    }
  }
  return ds;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** All generated files (path relative to the data dir → content). Pure function of the hand-authored files and SEED. */
export function generateFiles(dir = DATA_DIR): Map<string, string> {
  const r = rng(SEED);
  const catalog = readCatalog(dir);
  const files = new Map<string, string>();
  files.set(GENERATED.nimbusFindings, json(nimbusFiller(r)));
  for (const d of readHistorySpec(dir).deals) files.set(GENERATED.history(d.code), json(historyDeal(r, catalog, d)));

  // The manifest describes the full dataset, so build it from the hand-authored files plus what we just generated.
  const generated = [...files.values()].map((c) => JSON.parse(c) as Dataset);
  const dataset = readDataset(dir, generated);
  files.set(GENERATED.manifest, json(manifestOf(dataset)));
  return files;
}
