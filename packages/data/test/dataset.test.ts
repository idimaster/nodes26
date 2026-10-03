import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DATA_DIR,
  edgeCoverage,
  manifestOf,
  nodes,
  readDataset,
  relationships,
  validateDataset,
  type Dataset,
} from '../src/index.js';

const ds = readDataset();

describe('dataset validates against the ontology (T1.3)', () => {
  it('has no validation problems', () => {
    expect(validateDataset(ds)).toEqual([]);
  });

  it('matches the DATA.md sizes', () => {
    const count = (label: string) => nodes(ds, label).length;
    expect(count('Pattern')).toBeGreaterThanOrEqual(22);
    expect(count('Pattern')).toBeLessThanOrEqual(30);
    expect(count('UseCase')).toBeGreaterThanOrEqual(27);
    expect(count('UseCase')).toBeLessThanOrEqual(33);
    expect(count('Track')).toBe(6);
    expect(count('BuildOption')).toBeGreaterThanOrEqual(8);
    expect(count('PlatformCapability')).toBeGreaterThanOrEqual(7);
    const nimbusFindings = nodes(ds, 'Finding').filter((f) => f.deal_code === 'nimbus');
    expect(nimbusFindings.length).toBeGreaterThanOrEqual(22);
    expect(nimbusFindings.length).toBeLessThanOrEqual(28);
  });

  it('has not_recommended_when rules on at least 5 patterns', () => {
    const withRules = nodes(ds, 'Pattern').filter(
      (p) => Array.isArray(p.not_recommended_when) && p.not_recommended_when.length > 0,
    );
    expect(withRules.length).toBeGreaterThanOrEqual(5);
  });

  it('gives every pattern a track, a strategy, a use case, and at least two tasks', () => {
    for (const p of nodes(ds, 'Pattern')) {
      const from = (type: string) => relationships(ds, type).filter((r) => r.from.key.id === p.id);
      expect(from('IN_TRACK'), `${String(p.id)} IN_TRACK`).toHaveLength(1);
      expect(from('APPLIES_TO').length, `${String(p.id)} APPLIES_TO`).toBeGreaterThan(0);
      expect(from('SOLVES').length, `${String(p.id)} SOLVES`).toBeGreaterThan(0);
      expect(from('HAS_TASK').length, `${String(p.id)} HAS_TASK`).toBeGreaterThanOrEqual(2);
    }
  });

  it('includes Nimbus findings with both strong and weak evidence, plus service CALLS edges', () => {
    const nimbus = nodes(ds, 'Finding').filter((f) => f.deal_code === 'nimbus');
    const strong = new Set(['code_inspection', 'vendor_docs', 'rfi']);
    expect(nimbus.some((f) => strong.has(String(f.evidence_type)) && Number(f.confidence) >= 0.7)).toBe(true);
    expect(nimbus.some((f) => !strong.has(String(f.evidence_type)) || Number(f.confidence) < 0.7)).toBe(true);
    expect(relationships(ds, 'CALLS').length).toBeGreaterThanOrEqual(3);
    for (const f of nimbus) {
      expect(
        relationships(ds, 'SUPPORTED_BY').some((r) => r.from.key.id === f.id && r.from.key.deal_code === 'nimbus'),
        `${String(f.id)} has a source`,
      ).toBe(true);
    }
  });

  it('has exactly one critical gap in Nimbus (the P1 finding)', () => {
    const critical = nodes(ds, 'Finding').filter(
      (f) => f.deal_code === 'nimbus' && f.kind === 'gap' && f.severity === 'critical',
    );
    expect(critical.map((f) => f.id)).toEqual(['f-no-scim']);
  });
});

describe('catalog knowledge-edge coverage (DATA.md, V7 floor)', () => {
  it('is at least 0.6', () => {
    const { covered, total, ratio } = edgeCoverage(ds);
    expect(total).toBe(nodes(ds, 'Pattern').length);
    expect(covered).toBeGreaterThan(0);
    expect(ratio).toBeGreaterThanOrEqual(0.6);
  });
});

describe('data/manifest.json', () => {
  it('matches the counts of the dataset', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(DATA_DIR, 'manifest.json'), 'utf8'));
    expect(manifest).toEqual(manifestOf(ds));
  });
});

describe('validateDataset catches broken data', () => {
  const clone = (): Dataset => structuredClone(ds);

  it('reports a missing required property', () => {
    const bad = clone();
    delete bad.nodes.Pattern![0]!.reference;
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/Pattern .* missing reference/));
  });

  it('reports a value outside an enum', () => {
    const bad = clone();
    bad.nodes.Finding![0]!.severity = 'catastrophic';
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/Finding .* severity/));
  });

  it('reports a wrongly typed property', () => {
    const bad = clone();
    bad.nodes.Track![0]!.order = 'first';
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/Track .* order .* integer/));
  });

  it('reports a duplicate key', () => {
    const bad = clone();
    bad.nodes.Track!.push(structuredClone(bad.nodes.Track![0]!));
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/Track .* duplicate key/));
  });

  it('reports a relationship to a node that does not exist', () => {
    const bad = clone();
    bad.relationships.SOLVES![0]!.to.key.id = 'no-such-use-case';
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/SOLVES .*no-such-use-case.* does not exist/));
  });

  it('reports a relationship between labels the ontology does not allow', () => {
    const bad = clone();
    bad.relationships.SOLVES![0]!.to = { label: 'Strategy', key: { id: 'bridge' } };
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/SOLVES .* Pattern->Strategy/));
  });

  it('reports a label that is not in the ontology', () => {
    const bad = clone();
    bad.nodes.DataResidencyRequirement = [{ id: 'x' }];
    expect(validateDataset(bad)).toContainEqual(expect.stringMatching(/unknown label DataResidencyRequirement/));
  });
});

describe('dataset slices', () => {
  it('catalog + deal + history together equal the full dataset', async () => {
    const { readCatalogDataset, readDealDataset, readHistoryDataset, merge } = await import('../src/index.js');
    expect(merge(readCatalogDataset(), readDealDataset(), readHistoryDataset())).toEqual(ds);
  });
});
