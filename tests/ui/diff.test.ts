import { describe, expect, it } from 'vitest';
import { diffGraph, type GraphSnapshot } from '../../viz/src/diff.js';

const n = (id: string, caption = id, extra: Partial<GraphSnapshot['nodes'][number]> = {}) => ({ id, labels: ['Pattern'], subgraph: 'knowledge' as const, caption, ...extra });
const r = (id: string, from: string, to: string) => ({ id, from, to, type: 'REQUIRES' });
const snap = (nodes: GraphSnapshot['nodes'], rels: GraphSnapshot['rels'] = []): GraphSnapshot => ({ nodes, rels });

describe('diffGraph', () => {
  it('unchanged graphs give an empty diff', () => {
    const a = snap([n('a'), n('b')], [r('r1', 'a', 'b')]);
    expect(diffGraph(a, structuredClone(a))).toEqual({ added: { nodes: [], rels: [] }, updated: [], removed: { nodes: [], rels: [] } });
  });

  it('reports added, updated (caption, emphasis, status), and removed by id', () => {
    const before = snap([n('a'), n('b', 'B'), n('c'), n('d', 'd', { status: 'draft' })], [r('r1', 'a', 'b'), r('r2', 'b', 'c')]);
    const after = snap(
      [n('a'), n('b', 'B2'), n('d', 'd', { status: 'committed' }), n('e', 'e', { emphasis: 'witness' })],
      [r('r1', 'a', 'b'), r('r3', 'a', 'e')],
    );
    const d = diffGraph(before, after);
    expect(d.added.nodes.map((x) => x.id)).toEqual(['e']);
    expect(d.added.rels.map((x) => x.id)).toEqual(['r3']);
    expect(d.updated.map((x) => x.id).sort()).toEqual(['b', 'd']);
    expect(d.removed).toEqual({ nodes: ['c'], rels: ['r2'] });
  });

  it('from nothing, everything is added', () => {
    const d = diffGraph(null, snap([n('a')], []));
    expect(d.added.nodes.map((x) => x.id)).toEqual(['a']);
  });
});
