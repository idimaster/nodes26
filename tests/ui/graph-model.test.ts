import { describe, expect, it } from 'vitest';
import { captionOf, emphasisOf, subgraphOf, toNodeDTO, truncate, versionOf, type RawNode } from '@planner/gate/ui';

const node = (labels: string[], properties: Record<string, unknown>, elementId = `e-${labels[0]}`): RawNode => ({ elementId, labels, properties });

describe('captions (≤ 28 characters, ellipsized)', () => {
  it.each([
    [['Pattern'], { name: 'CDC replication' }, 'CDC replication'],
    [['Task'], { summary: 'Enable change-log access on the target database' }, 'Enable change-log access on…'],
    [['PlanTask'], { summary: 'x', task_id: 'oidc-broker.login-flow' }, 'x'],
    [['PlanTask'], { task_id: 'oidc-broker.login-flow' }, 'oidc-broker.login-flow'],
    [['Finding'], { kind: 'gap', text: 'No SCIM' }, 'gap: No SCIM'],
    [['FramedUseCase'], { use_case_id: 'user-provisioning' }, 'user-provisioning'],
    [['Selection'], { uc: 'sso', pattern: 'oidc-broker' }, 'sso → oidc-broker'],
    [['Candidate'], { pattern: 'cdc-replication', fit_score: 85.3 }, 'cdc-replication (85.3)'],
    [['GateDecision'], { gate: 'select', status: 'pending' }, 'select: pending'],
    [['Feedback'], { text: 'Ledger sync must not read the production log' }, 'Ledger sync must not read t…'],
    [['Override'], { kind: 'exclude_pattern', subject: 'cdc' }, 'exclude_pattern cdc'],
    [['OntologyTerm'], { name: 'DataResidencyRequirement' }, 'DataResidencyRequirement'],
    [['CapabilityDecision'], { capability_id: 'sso', outcome: 'integrate' }, 'sso: integrate'],
    [['Iteration'], { n: 2 }, 'iteration 2'],
  ])('%s', (labels, props, caption) => {
    const c = captionOf(labels as string[], props);
    expect(c).toBe(caption);
    expect(c.length).toBeLessThanOrEqual(28);
  });
});

describe('subgraph and emphasis', () => {
  it('maps labels to the subgraph colors, with ontology for terms and their instances', () => {
    expect(subgraphOf(['Pattern'])).toBe('knowledge');
    expect(subgraphOf(['Finding'])).toBe('evidence');
    expect(subgraphOf(['PlanTask'])).toBe('plan');
    expect(subgraphOf(['GateDecision'])).toBe('decisions');
    expect(subgraphOf(['OntologyTerm'])).toBe('ontology');
    expect(subgraphOf(['DataResidencyRequirement'])).toBe('ontology');
  });

  it('witness beats critical path beats draft', () => {
    const t = node(['PlanTask'], { status: 'draft', on_critical_path: true }, 'e1');
    expect(emphasisOf(t, new Set())).toBe('critical_path');
    expect(emphasisOf(t, new Set(['e1']))).toBe('witness');
    expect(emphasisOf(node(['Selection'], { status: 'draft' }), new Set())).toBe('draft');
    expect(emphasisOf(node(['Selection'], { status: 'committed' }), new Set())).toBeUndefined();
  });

  it('builds the DTO', () => {
    expect(toNodeDTO(node(['Selection'], { uc: 'sso', pattern: 'oidc-broker', status: 'draft' }, 'e9'), new Set())).toEqual({
      id: 'e9',
      labels: ['Selection'],
      subgraph: 'plan',
      caption: 'sso → oidc-broker',
      status: 'draft',
      emphasis: 'draft',
    });
  });
});

describe('truncation by scene priority', () => {
  it('keeps whole higher-priority groups first, then fills, and reports truncation', () => {
    const g = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => node(['Pattern'], {}, `${prefix}${i}`));
    const { nodes, truncated } = truncate([g('a', 100), g('b', 40), g('c', 30)], 150);
    expect(nodes).toHaveLength(150);
    expect(truncated).toBe(true);
    expect(nodes.filter((n) => n.elementId.startsWith('c'))).toHaveLength(10);
    expect(truncate([g('a', 3)], 150)).toEqual({ nodes: g('a', 3), truncated: false });
  });

  it('never lists a node twice across groups', () => {
    const x = node(['Pattern'], {}, 'same');
    expect(truncate([[x], [x]], 150).nodes).toHaveLength(1);
  });
});

describe('version', () => {
  const a = node(['Selection'], { status: 'draft', fit_score: 70 }, 'n1');
  const b = node(['PlanTask'], { on_critical_path: false }, 'n2');
  it('is stable for the same graph in any order, and changes when a node or a shown property changes', () => {
    const v = versionOf([a, b], ['r1']);
    expect(versionOf([b, a], ['r1'])).toBe(v);
    expect(versionOf([a, b, node(['Pattern'], {}, 'n3')], ['r1'])).not.toBe(v);
    expect(versionOf([{ ...a, properties: { ...a.properties, status: 'committed' } }, b], ['r1'])).not.toBe(v);
    expect(versionOf([a, b], ['r1', 'r2'])).not.toBe(v);
  });
});
