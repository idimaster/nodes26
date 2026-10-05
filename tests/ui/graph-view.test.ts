import { describe, expect, it, vi } from 'vitest';
import { GraphView, type CyLike } from '../../viz/src/graph-view.js';
import type { GraphSnapshot } from '../../viz/src/diff.js';

/** The adapter must update incrementally on every poll and lay out only on reset. Cytoscape is mocked. */

function mockCy() {
  const elements = new Map<string, { data: Record<string, unknown>; position: { x: number; y: number } | undefined; classes: Set<string> }>();
  const layoutRuns: string[] = [];
  const el = (id: string) => {
    const e = elements.get(id);
    return {
      length: e ? 1 : 0,
      data: (k?: string, v?: unknown) => (v === undefined ? (k ? e?.data[k] : e?.data) : e && (e.data[k as string] = v)),
      position: () => e?.position ?? { x: 0, y: 0 },
      classes: (c: string) => e && (e.classes = new Set(c.split(' ').filter(Boolean))),
      remove: () => elements.delete(id),
      neighborhood: () => ({ nodes: () => [] }),
      isNode: () => true,
    };
  };
  const cy = {
    add: vi.fn((defs: { group: string; data: { id: string }; position?: { x: number; y: number } }[]) => {
      for (const d of defs) elements.set(d.data.id, { data: { ...d.data }, position: d.position, classes: new Set() });
    }),
    getElementById: vi.fn(el),
    elements: () => ({ remove: () => elements.clear(), boundingBox: () => ({ x2: 100, y1: 0, y2: 100 }) }),
    nodes: () => ({ boundingBox: () => ({ x2: 100, y1: 0, y2: 100 }), length: elements.size }),
    layout: vi.fn((opts: { name: string }) => ({ run: () => layoutRuns.push(opts.name), on: () => undefined, one: () => undefined })),
    batch: (f: () => void) => f(),
    fit: vi.fn(),
    zoom: vi.fn(() => 1),
    pan: vi.fn(() => ({ x: 0, y: 0 })),
    animate: vi.fn(),
    collection: vi.fn(() => ({ merge: () => undefined })),
  };
  return { cy: cy as unknown as CyLike, elements, layoutRuns, raw: cy };
}

const snap = (ids: string[], rels: [string, string, string][] = []): GraphSnapshot => ({
  nodes: ids.map((id) => ({ id, labels: ['Pattern'], subgraph: 'knowledge', caption: id })),
  rels: rels.map(([id, from, to]) => ({ id, from, to, type: 'REQUIRES' })),
});

describe('GraphView', () => {
  it('lays out once on reset, then applies polls incrementally without re-layout', () => {
    const { cy, elements, layoutRuns, raw } = mockCy();
    const view = new GraphView(cy);
    view.reset(snap(['a', 'b'], [['r1', 'a', 'b']]), 'hierarchical');
    expect(layoutRuns).toEqual(['dagre']);
    view.update(snap(['a', 'b', 'c'], [['r1', 'a', 'b'], ['r2', 'b', 'c']]));
    view.update(snap(['a', 'c'], [['r2b', 'a', 'c']]));
    view.update(snap(['a', 'c'], [['r2b', 'a', 'c']]));
    expect(layoutRuns).toEqual(['dagre']); // never again during polling
    expect([...elements.keys()].sort()).toEqual(['a', 'c', 'r2b']);
    expect(raw.add).toHaveBeenCalledTimes(3); // reset, then the two polls that added something
  });

  it('uses force-directed layout for scenes 1 and 3', () => {
    const { cy, layoutRuns } = mockCy();
    new GraphView(cy).reset(snap(['a']), 'force');
    expect(layoutRuns).toEqual(['fcose']);
  });

  it('updates captions and emphasis in place', () => {
    const { cy, elements } = mockCy();
    const view = new GraphView(cy);
    view.reset(snap(['a']), 'force');
    view.update({ nodes: [{ id: 'a', labels: ['Pattern'], subgraph: 'knowledge', caption: 'A!', emphasis: 'witness' }], rels: [] });
    expect(elements.get('a')?.data.label).toBe('A!');
    expect([...(elements.get('a')?.classes ?? [])]).toEqual(['knowledge', 'witness']);
  });

  it('highlight() adds a class that survives later polls, and clears', () => {
    const { cy, elements } = mockCy();
    const view = new GraphView(cy);
    view.reset(snap(['a', 'b']), 'force');
    view.highlight('provenance', ['a', 'zzz']);
    expect([...(elements.get('a')?.classes ?? [])]).toEqual(['knowledge', 'provenance']);
    view.update({ nodes: [{ id: 'a', labels: ['Pattern'], subgraph: 'knowledge', caption: 'A2' }, { id: 'b', labels: ['Pattern'], subgraph: 'knowledge', caption: 'b' }], rels: [] });
    expect([...(elements.get('a')?.classes ?? [])]).toEqual(['knowledge', 'provenance']);
    view.highlight('provenance', []);
    expect([...(elements.get('a')?.classes ?? [])]).toEqual(['knowledge']);
  });

  it('edges between two critical-path nodes are marked', () => {
    const { cy, raw } = mockCy();
    const s = snap(['a', 'b', 'c'], [['r1', 'a', 'b'], ['r2', 'b', 'c']]);
    for (const n of s.nodes) if (n.id !== 'c') n.emphasis = 'critical_path';
    new GraphView(cy).reset(s, 'hierarchical');
    const defs = raw.add.mock.calls[0]?.[0] as { data: { id: string }; classes?: string }[];
    expect(defs.find((d) => d.data.id === 'r1')?.classes).toBe('critical_path');
    expect(defs.find((d) => d.data.id === 'r2')?.classes).toBe('');
  });
});
