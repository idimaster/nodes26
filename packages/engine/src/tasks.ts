export interface CatalogTask {
  /** Catalog Task id, `<pattern>.<task>`. */
  id: string;
  weeks_o: number;
  weeks_e: number;
  weeks_p: number;
  skill: string;
  /** Catalog Task ids within the same pattern. */
  depends_on: string[];
}

export interface SelectionInput {
  /** UseCase id. */
  uc: string;
  pattern: string;
  /** Pattern ids this pattern REQUIRES. */
  requires: string[];
  tasks: CatalogTask[];
}

export interface PlanTaskDraft {
  deal_code: string;
  iteration: number;
  id: string;
  uc: string;
  task_id: string;
  weeks_o: number;
  weeks_e: number;
  weeks_p: number;
  skill: string;
}

export interface Dependency {
  /** The dependent PlanTask id. */
  from: string;
  /** Its prerequisite PlanTask id. */
  to: string;
}

const planTaskId = (uc: string, taskId: string) => `${uc}:${taskId}`;

/** DESIGN §2.3: PlanTasks plus intra-pattern edges and root-to-final edges across REQUIRES. */
export function instantiateTasks(input: {
  deal: string;
  iteration: number;
  selections: SelectionInput[];
}): { plan_tasks: PlanTaskDraft[]; depends_on: Dependency[] } {
  const plan_tasks: PlanTaskDraft[] = [];
  const depends_on: Dependency[] = [];

  const finalTasks = (s: SelectionInput) =>
    s.tasks.filter((t) => !s.tasks.some((x) => x.depends_on.includes(t.id))).map((t) => planTaskId(s.uc, t.id));

  for (const s of input.selections) {
    const own = new Set(s.tasks.map((t) => t.id));
    const prerequisites = input.selections
      .filter((o) => o !== s && s.requires.includes(o.pattern))
      .flatMap(finalTasks);
    for (const t of s.tasks) {
      const id = planTaskId(s.uc, t.id);
      plan_tasks.push({
        deal_code: input.deal,
        iteration: input.iteration,
        id,
        uc: s.uc,
        task_id: t.id,
        weeks_o: t.weeks_o,
        weeks_e: t.weeks_e,
        weeks_p: t.weeks_p,
        skill: t.skill,
      });
      for (const d of t.depends_on) {
        if (!own.has(d)) throw new Error(`${t.id} depends on ${d}, which is not a task of pattern ${s.pattern}`);
        depends_on.push({ from: id, to: planTaskId(s.uc, d) });
      }
      if (t.depends_on.length === 0) for (const p of prerequisites) depends_on.push({ from: id, to: p });
    }
  }
  return { plan_tasks, depends_on };
}
