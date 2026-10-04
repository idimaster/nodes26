import { describe, expect, it } from 'vitest';
import { parseOverrides } from '../src/grammar.js';

const catalog = {
  patterns: new Set(['cdc-replication', 'event-bus-bridge']),
  useCases: new Set(['ledger-data-sync', 'reporting-consolidation']),
};

describe('parseOverrides (DESIGN §4 grammar)', () => {
  it.each([
    ['remove cdc-replication', [{ kind: 'exclude_pattern', subject: 'cdc-replication', value: '' }]],
    ['except cdc-replication', [{ kind: 'exclude_pattern', subject: 'cdc-replication', value: '' }]],
    ['remove ledger-data-sync', [{ kind: 'exclude_use_case', subject: 'ledger-data-sync', value: '' }]],
    ['except reporting-consolidation', [{ kind: 'exclude_use_case', subject: 'reporting-consolidation', value: '' }]],
    ['keep event-bus-bridge', [{ kind: 'pin_pattern', subject: 'event-bus-bridge', value: '' }]],
    ['include ledger-data-sync', [{ kind: 'include_use_case', subject: 'ledger-data-sync', value: '' }]],
    ['use bridge for ledger-data-sync', [{ kind: 'strategy_for', subject: 'ledger-data-sync', value: 'bridge' }]],
    ['use transform for cdc-replication', [{ kind: 'strategy_for', subject: 'cdc-replication', value: 'transform' }]],
    ['directive: Prefer patterns Harborline already runs.', [{ kind: 'directive', subject: '', value: 'Prefer patterns Harborline already runs.' }]],
  ])('%s', (comment, expected) => {
    expect(parseOverrides(comment, catalog)).toEqual(expected);
  });

  it('reads one override per line or sentence, case-insensitively, ignoring trailing punctuation', () => {
    expect(parseOverrides('Too risky. Remove cdc-replication.\nKeep event-bus-bridge; use bridge for ledger-data-sync!', catalog)).toEqual([
      { kind: 'exclude_pattern', subject: 'cdc-replication', value: '' },
      { kind: 'pin_pattern', subject: 'event-bus-bridge', value: '' },
      { kind: 'strategy_for', subject: 'ledger-data-sync', value: 'bridge' },
    ]);
  });

  it('ignores prose and unknown ids (they stay Feedback only)', () => {
    expect(parseOverrides('This looks slow to me.', catalog)).toEqual([]);
    expect(parseOverrides('remove some-unknown-pattern', catalog)).toEqual([]);
    expect(parseOverrides('keep ledger-data-sync', catalog)).toEqual([]); // keep applies to patterns only
    expect(parseOverrides('include cdc-replication', catalog)).toEqual([]); // include applies to use cases only
    expect(parseOverrides('', catalog)).toEqual([]);
  });

  it('does not repeat the same override', () => {
    expect(parseOverrides('remove cdc-replication\nexcept cdc-replication', catalog)).toHaveLength(1);
  });
});
