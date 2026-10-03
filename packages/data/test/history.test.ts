import { describe, expect, it } from 'vitest';
import { nodes, readDataset, relationships } from '../src/index.js';

const ds = readDataset();
const HISTORY = ['tidewater', 'quarry'];

describe('history deals (DATA.md)', () => {
  it('has at least 5 catalog Tasks with at least 3 Actual observations', () => {
    const perTask = new Map<string, number>();
    for (const a of nodes(ds, 'Actual')) perTask.set(String(a.task_id), (perTask.get(String(a.task_id)) ?? 0) + 1);
    const wellObserved = [...perTask.values()].filter((n) => n >= 3);
    expect(wellObserved.length).toBeGreaterThanOrEqual(5);
  });

  it('has about 40 Actuals in total, each observing an existing PlanTask of the same deal', () => {
    const actuals = nodes(ds, 'Actual');
    expect(actuals.length).toBeGreaterThanOrEqual(35);
    expect(actuals.length).toBeLessThanOrEqual(60);
    const planTasks = new Set(nodes(ds, 'PlanTask').map((t) => `${String(t.deal_code)}/${String(t.id)}`));
    for (const a of actuals) {
      expect(planTasks.has(`${String(a.deal_code)}/${String(a.plan_task_id)}`)).toBe(true);
      expect(Number(a.weeks_actual)).toBeGreaterThan(0);
    }
  });

  it.each(HISTORY)('%s has a committed roadmap backed by an approved commit gate', (deal) => {
    const deals = nodes(ds, 'Deal').filter((d) => d.code === deal);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.status).toBe('completed');
    const roadmaps = nodes(ds, 'Roadmap').filter((r) => r.deal_code === deal);
    expect(roadmaps).toHaveLength(1);
    expect(roadmaps[0]!.status).toBe('committed');
    const gate = nodes(ds, 'GateDecision').find((g) => g.id === roadmaps[0]!.gate_id);
    expect(gate).toMatchObject({ deal_code: deal, gate: 'commit', status: 'approved' });
    const selections = nodes(ds, 'Selection').filter((s) => s.deal_code === deal);
    expect(selections.length).toBeGreaterThan(0);
    expect(selections.every((s) => s.status === 'committed')).toBe(true);
  });

  it.each(HISTORY)('%s selections are closed under REQUIRES', (deal) => {
    const selected = new Set(nodes(ds, 'Selection').filter((s) => s.deal_code === deal).map((s) => String(s.pattern)));
    for (const r of relationships(ds, 'REQUIRES')) {
      if (selected.has(String(r.from.key.id))) {
        expect(selected.has(String(r.to.key.id)), `${deal}: ${String(r.from.key.id)} requires ${String(r.to.key.id)}`).toBe(
          true,
        );
      }
    }
  });

  it.each(HISTORY)('%s plan tasks follow the DESIGN §5.2 schedule definitions', (deal) => {
    const tasks = nodes(ds, 'PlanTask').filter((t) => t.deal_code === deal);
    const byId = new Map(tasks.map((t) => [String(t.id), t]));
    const deps = relationships(ds, 'DEPENDS_ON').filter((r) => r.from.label === 'PlanTask' && r.from.key.deal_code === deal);
    const prereqs = (id: string) => deps.filter((r) => r.from.key.id === id).map((r) => byId.get(String(r.to.key.id))!);
    for (const t of tasks) {
      const pre = prereqs(String(t.id));
      const es = pre.length ? Math.max(...pre.map((p) => Number(p.earliest_start) + Number(p.weeks_e))) : 0;
      const wave = pre.length ? 1 + Math.max(...pre.map((p) => Number(p.wave))) : 1;
      expect(Number(t.earliest_start)).toBeCloseTo(es, 9);
      expect(t.wave).toBe(wave);
    }
    expect(tasks.some((t) => t.on_critical_path === true)).toBe(true);
  });
});
