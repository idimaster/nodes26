import { round } from './round.js';
import type { Dependency } from './tasks.js';

export interface ScheduleTask {
  id: string;
  weeks_o: number;
  weeks_e: number;
  weeks_p: number;
}

export interface TaskSchedule {
  id: string;
  earliest_start: number;
  wave: number;
  on_critical_path: boolean;
}

export interface Schedule {
  tasks: TaskSchedule[];
  finish: number;
  critical_path: string[];
  pert: { mean: number; sigma: number; p10: number; p90: number };
}

/** Thrown on cyclic input. `witness` is the cycle in DEPENDS_ON order, from its smallest id, closed. */
export class CycleError extends Error {
  constructor(readonly witness: string[]) {
    super(`task dependencies contain a cycle: ${witness.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

const EPS = 1e-9;
const Z90 = 1.2816;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function get<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`internal: missing ${String(key)}`);
  return v;
}

/** DESIGN §2.3 and §5.2: Kahn longest path over weeks_e; refuses cyclic input with a witness. */
export function computeSchedule(tasks: ScheduleTask[], dependsOn: Dependency[]): Schedule {
  const task = new Map(tasks.map((t) => [t.id, t]));
  if (task.size !== tasks.length) {
    const seen = new Set<string>();
    const dup = tasks.find((t) => (seen.has(t.id) ? true : (seen.add(t.id), false)));
    throw new Error(`duplicate task id ${dup?.id ?? ''}`);
  }
  const prereqs = new Map<string, Set<string>>(tasks.map((t) => [t.id, new Set()]));
  const dependents = new Map<string, Set<string>>(tasks.map((t) => [t.id, new Set()]));
  for (const { from, to } of dependsOn) {
    for (const id of [from, to]) if (!task.has(id)) throw new Error(`dependency on unknown task ${id}`);
    get(prereqs, from).add(to);
    get(dependents, to).add(from);
  }

  // Kahn, always taking the smallest ready id so the order is deterministic.
  const indegree = new Map(tasks.map((t) => [t.id, get(prereqs, t.id).size]));
  const ready = tasks.filter((t) => get(indegree, t.id) === 0).map((t) => t.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(byId);
    const id = ready.shift() as string;
    order.push(id);
    for (const d of get(dependents, id)) {
      indegree.set(d, get(indegree, d) - 1);
      if (get(indegree, d) === 0) ready.push(d);
    }
  }
  if (order.length < tasks.length) throw new CycleError(findCycle(tasks, prereqs, new Set(order)));

  const es = new Map<string, number>();
  const wave = new Map<string, number>();
  for (const id of order) {
    const pre = [...get(prereqs, id)];
    es.set(id, pre.length ? Math.max(...pre.map((p) => get(es, p) + get(task, p).weeks_e)) : 0);
    wave.set(id, pre.length ? 1 + Math.max(...pre.map((p) => get(wave, p))) : 1);
  }
  const finish = order.length ? Math.max(...order.map((id) => get(es, id) + get(task, id).weeks_e)) : 0;
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const succ = [...get(dependents, id)];
    const lf = succ.length ? Math.min(...succ.map((s) => get(ls, s))) : finish;
    ls.set(id, lf - get(task, id).weeks_e);
  }
  const critical = (id: string) => Math.abs(get(ls, id) - get(es, id)) < EPS;

  // One critical path: from the smallest critical source, follow tight critical successors.
  const path: string[] = [];
  let current = order.filter((id) => get(prereqs, id).size === 0 && critical(id)).sort(byId)[0];
  while (current !== undefined) {
    path.push(current);
    const end = get(es, current) + get(task, current).weeks_e;
    current = [...get(dependents, current)]
      .filter((d) => critical(d) && Math.abs(get(es, d) - end) < EPS)
      .sort(byId)[0];
  }

  const mean = path.reduce((s, id) => {
    const t = get(task, id);
    return s + (t.weeks_o + 4 * t.weeks_e + t.weeks_p) / 6;
  }, 0);
  const sigma = Math.sqrt(
    path.reduce((s, id) => {
      const t = get(task, id);
      return s + ((t.weeks_p - t.weeks_o) / 6) ** 2;
    }, 0),
  );

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      earliest_start: round(get(es, t.id), 6),
      wave: get(wave, t.id),
      on_critical_path: critical(t.id),
    })),
    finish: round(finish, 6),
    critical_path: path,
    pert: {
      mean: round(mean, 2),
      sigma: round(sigma, 2),
      p10: round(mean - Z90 * sigma, 2),
      p90: round(mean + Z90 * sigma, 2),
    },
  };
}

/** Every task Kahn could not order has an unordered prerequisite, so walking prerequisites must loop. */
function findCycle(tasks: ScheduleTask[], prereqs: Map<string, Set<string>>, ordered: Set<string>): string[] {
  const remaining = tasks.map((t) => t.id).filter((id) => !ordered.has(id)).sort(byId);
  const walk: string[] = [];
  let current = remaining[0] as string;
  while (!walk.includes(current)) {
    walk.push(current);
    current = [...get(prereqs, current)].filter((p) => !ordered.has(p)).sort(byId)[0] as string;
  }
  const cycle = walk.slice(walk.indexOf(current));
  const start = cycle.indexOf([...cycle].sort(byId)[0] as string);
  const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
  return [...rotated, rotated[0] as string];
}
