import { must } from './types.js';

export interface ScheduleInput {
  id: string;
  weeks_e: number;
  /** Prerequisites (DEPENDS_ON targets). */
  deps: string[];
}

export interface ScheduleFields {
  earliest_start: number;
  wave: number;
  on_critical_path: boolean;
}

/**
 * DESIGN §5.2 schedule fields for an acyclic task set. Used only to give the generated
 * history plans realistic values; the planner's scheduler is the engine's compute_schedule (T2.1).
 */
export function scheduleFields(tasks: ScheduleInput[]): Map<string, ScheduleFields> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = (id: string) => must(byId.get(id), `task ${id}`);
  const order: ScheduleInput[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (t: ScheduleInput): void => {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'visiting') throw new Error(`cycle through ${t.id}`);
    state.set(t.id, 'visiting');
    for (const d of t.deps) visit(task(d));
    state.set(t.id, 'done');
    order.push(t);
  };
  tasks.forEach(visit);

  const es = new Map<string, number>();
  const wave = new Map<string, number>();
  const esOf = (id: string) => must(es.get(id), `earliest start of ${id}`);
  for (const t of order) {
    es.set(t.id, t.deps.length ? Math.max(...t.deps.map((d) => esOf(d) + task(d).weeks_e)) : 0);
    wave.set(t.id, t.deps.length ? 1 + Math.max(...t.deps.map((d) => must(wave.get(d), `wave of ${d}`))) : 1);
  }
  const finish = Math.max(...order.map((t) => esOf(t.id) + t.weeks_e));
  const latestStart = new Map<string, number>();
  for (const t of [...order].reverse()) {
    const dependents = order.filter((x) => x.deps.includes(t.id));
    const latestFinish = dependents.length
      ? Math.min(...dependents.map((x) => must(latestStart.get(x.id), `latest start of ${x.id}`)))
      : finish;
    latestStart.set(t.id, latestFinish - t.weeks_e);
  }
  return new Map(
    order.map((t) => [
      t.id,
      {
        earliest_start: esOf(t.id),
        wave: must(wave.get(t.id), `wave of ${t.id}`),
        on_critical_path: Math.abs(must(latestStart.get(t.id), `latest start of ${t.id}`) - esOf(t.id)) < 1e-9,
      },
    ]),
  );
}
