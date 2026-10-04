import { describe, expect, it } from 'vitest';
import { instantiateTasks, type SelectionInput } from '../src/index.js';

const trust: SelectionInput = {
  uc: 'u1',
  pattern: 'trust',
  requires: [],
  tasks: [
    { id: 'trust.a', weeks_o: 1, weeks_e: 1, weeks_p: 2, skill: 'identity', depends_on: [] },
    { id: 'trust.b', weeks_o: 1, weeks_e: 2, weeks_p: 3, skill: 'security', depends_on: ['trust.a'] },
  ],
};
const scimTasks: SelectionInput['tasks'] = [
  { id: 'scim.x', weeks_o: 1, weeks_e: 2, weeks_p: 3, skill: 'identity', depends_on: [] },
  { id: 'scim.y', weeks_o: 0.5, weeks_e: 1, weeks_p: 2, skill: 'ops', depends_on: ['scim.x'] },
];

describe('instantiateTasks (DESIGN §2.3)', () => {
  const out = instantiateTasks({
    deal: 'nimbus',
    iteration: 1,
    selections: [
      trust,
      { uc: 'u2', pattern: 'scim', requires: ['trust', 'not-selected'], tasks: scimTasks },
      { uc: 'u3', pattern: 'scim', requires: ['trust'], tasks: scimTasks },
    ],
  });

  it('creates one PlanTask per catalog task per selection, with <uc>:<task> ids', () => {
    expect(out.plan_tasks.map((t) => t.id)).toEqual([
      'u1:trust.a',
      'u1:trust.b',
      'u2:scim.x',
      'u2:scim.y',
      'u3:scim.x',
      'u3:scim.y',
    ]);
    expect(out.plan_tasks[3]).toEqual({
      deal_code: 'nimbus',
      iteration: 1,
      id: 'u2:scim.y',
      uc: 'u2',
      task_id: 'scim.y',
      weeks_o: 0.5,
      weeks_e: 1,
      weeks_p: 2,
      skill: 'ops',
    });
  });

  it('copies intra-pattern edges and links roots to the final tasks of required selections', () => {
    expect(out.depends_on).toEqual([
      { from: 'u1:trust.b', to: 'u1:trust.a' },
      { from: 'u2:scim.x', to: 'u1:trust.b' },
      { from: 'u2:scim.y', to: 'u2:scim.x' },
      { from: 'u3:scim.x', to: 'u1:trust.b' },
      { from: 'u3:scim.y', to: 'u3:scim.x' },
    ]);
  });

  it('rejects a dependency on a task outside the pattern', () => {
    expect(() =>
      instantiateTasks({
        deal: 'd',
        iteration: 1,
        selections: [{ ...trust, tasks: [{ ...scimTasks[0]!, depends_on: ['elsewhere.z'] }] }],
      }),
    ).toThrow(/elsewhere\.z/);
  });
});
