import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ontology } from '../src/index.js';

/**
 * Parses DESIGN.md §1.1 (label table) and §1.2 (relationship bullets) and asserts
 * config/ontology.json says exactly the same thing. Editing one without the other fails.
 */

const designPath = fileURLToPath(new URL('../../../docs/design/DESIGN.md', import.meta.url));
const design = readFileSync(designPath, 'utf8');

function section(start: string, end: string): string {
  const from = design.indexOf(start);
  const to = design.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`DESIGN.md section ${start} not found`);
  return design.slice(from, to);
}

interface DesignLabel {
  name: string;
  subgraph: string;
  perDeal: boolean;
  reserved: boolean;
  key: string[];
  required: string[];
  enums: Record<string, string[]>;
}

function parseLabels(): DesignLabel[] {
  const rows = section('### 1.1', '### 1.2')
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.startsWith('| Subgraph'));
  let subgraph = '';
  let perDeal = false;
  let reserved = false;
  return rows.map((row) => {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const [sg, labelCell, keyCell, reqCell] = cells as [string, string, string, string];
    if (sg) {
      subgraph = sg.split(' ')[0]!.toLowerCase();
      perDeal = sg.includes('per deal');
      reserved = sg.includes('reserved');
    }
    const keyToken = /`([^`]+)`/.exec(keyCell)![1]!;
    const key = keyToken.replace(/[()]/g, '').split(',').map((k) => k.trim());
    const required: string[] = [];
    const enums: Record<string, string[]> = {};
    for (const m of reqCell.matchAll(/`([a-z_/]+)`(?:\s*∈\s*\{([^}]*)\})?/g)) {
      const prop = m[1]!;
      const names = prop.includes('/')
        ? prop.split('/').map((suffix, i) => (i === 0 ? suffix : prop.split('_')[0] + '_' + suffix))
        : [prop];
      // A key property may appear in the required column only to declare its enum.
      required.push(...names.filter((x) => !key.includes(x)));
      const values = m[2];
      if (values && !values.includes('<')) {
        enums[prop] = values.split(',').map((v) => v.trim());
      }
    }
    return { name: labelCell.replace(/`/g, ''), subgraph, perDeal, reserved, key, required, enums };
  });
}

function parseRelationships(planLabels: string[]): { triples: Set<string>; props: Map<string, string[]> } {
  const triples = new Set<string>();
  const props = new Map<string, string[]>();
  const body = section('### 1.2', '### 1.3');
  const expand = (side: string) =>
    side.split('|').flatMap((s) => (s.trim() === 'any plan node' ? planLabels : [s.trim()]));
  for (const m of body.matchAll(/\(([^)]*)\)-\[:([A-Z_|]+)(?:\s*\{([^}]*)\})?\]->\(([^)]*)\)/g)) {
    const types = m[2]!.split('|');
    for (const type of types) {
      if (m[3]) props.set(type, m[3].split(',').map((p) => p.trim()));
      for (const from of expand(m[1]!)) for (const to of expand(m[4]!)) triples.add(`${from}-${type}->${to}`);
    }
  }
  return { triples, props };
}

const designLabels = parseLabels();
const planLabels = designLabels.filter((l) => l.subgraph === 'plan').map((l) => l.name);

describe('config/ontology.json matches DESIGN.md §1.1–§1.2', () => {
  it('has 23 labels, in the same order as DESIGN', () => {
    expect(designLabels).toHaveLength(23);
    expect(ontology.labels.map((l) => l.name)).toEqual(designLabels.map((l) => l.name));
  });

  it.each(designLabels.map((l) => [l.name, l] as const))('label %s matches', (_name, d) => {
    const j = ontology.labels.find((l) => l.name === d.name)!;
    expect({
      subgraph: j.subgraph,
      perDeal: j.perDeal,
      reserved: j.reserved,
      key: j.key,
      required: j.required,
      enums: j.enums,
    }).toEqual({
      subgraph: d.subgraph,
      perDeal: d.perDeal,
      reserved: d.reserved,
      key: d.key,
      required: d.required,
      enums: d.enums,
    });
  });

  it('has exactly the relationship endpoints in DESIGN', () => {
    const { triples } = parseRelationships(planLabels);
    const json = new Set(
      ontology.relationships.flatMap((r) =>
        r.endpoints.flatMap((e) => e.from.flatMap((f) => e.to.map((t) => `${f}-${r.type}->${t}`))),
      ),
    );
    expect([...json].sort()).toEqual([...triples].sort());
  });

  it('has the relationship properties in DESIGN', () => {
    const { props } = parseRelationships(planLabels);
    const json = new Map(ontology.relationships.filter((r) => r.properties.length).map((r) => [r.type, r.properties]));
    expect(json).toEqual(props);
  });
});
