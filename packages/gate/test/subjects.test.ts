import { describe, expect, it } from 'vitest';
import { parseSubject } from '../src/subjects.js';

describe('parseSubject', () => {
  it.each([
    ['Selection:ledger-data-sync', { label: 'Selection', key: { deal_code: 'nimbus', iteration: 2, uc: 'ledger-data-sync' } }],
    ['FramedUseCase:user-provisioning', { label: 'FramedUseCase', key: { deal_code: 'nimbus', iteration: 2, id: 'user-provisioning' } }],
    ['PlanTask:user-provisioning:scim-provisioning.scim-endpoint',
      { label: 'PlanTask', key: { deal_code: 'nimbus', iteration: 2, id: 'user-provisioning:scim-provisioning.scim-endpoint' } }],
    ['Candidate:ledger-data-sync/cdc-replication',
      { label: 'Candidate', key: { deal_code: 'nimbus', iteration: 2, uc: 'ledger-data-sync', pattern: 'cdc-replication' } }],
    ['Iteration:2', { label: 'Iteration', key: { deal_code: 'nimbus', n: 2 } }],
    ['Roadmap:1', { label: 'Roadmap', key: { deal_code: 'nimbus', version: 1 } }],
    ['CapabilityDecision:sso', { label: 'CapabilityDecision', key: { deal_code: 'nimbus', iteration: 2, capability_id: 'sso' } }],
    ['OntologyTerm:label/DataResidencyRequirement', { label: 'OntologyTerm', key: { kind: 'label', name: 'DataResidencyRequirement', scope: 'nimbus' } }],
  ])('%s', (ref, expected) => {
    expect(parseSubject(ref, 'nimbus', 2)).toEqual(expected);
  });

  it.each(['Selection', 'GateDecision:gd-1', 'Iteration:x', 'Candidate:only-uc', 'OntologyTerm:index/X', 'Selection:', 'constructor:x', 'toString:x'])(
    'rejects %s',
    (ref) => {
      expect(() => parseSubject(ref, 'nimbus', 2)).toThrow(/subject/);
    },
  );
});
