/**
 * Before (a): a list scheduler with no cycle check. Each pass schedules every task whose prerequisites are
 * scheduled, until all are. On a cycle no task on it ever becomes ready, so the loop never ends.
 * `maxPasses` exists only so the test can show that without hanging.
 */
export function naiveSchedule(tasks: { id: string; weeks_e: number; deps: string[] }[], maxPasses: number) {
  const start = new Map<string, number>();
  let passes = 0;
  while (start.size < tasks.length) {
    if (++passes > maxPasses) return { finished: false as const, passes: passes - 1, scheduled: [...start.keys()].sort() };
    for (const t of tasks) {
      if (start.has(t.id) || !t.deps.every((d) => start.has(d))) continue;
      start.set(t.id, Math.max(0, ...t.deps.map((d) => (start.get(d) ?? 0) + (tasks.find((x) => x.id === d)?.weeks_e ?? 0))));
    }
  }
  return { finished: true as const, passes, start };
}
