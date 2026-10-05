import { diffGraph, type GraphSnapshot, type NodeDTO } from './diff.js';

/**
 * Thin adapter over Cytoscape (T4.2: NVL was dropped, its license does not cover Neo4j Community).
 * reset() lays the graph out once (scene or iteration change). update() applies a poll incrementally:
 * new nodes are placed next to a neighbor already on screen, and existing nodes never move.
 */

/** The subset of the Cytoscape core API the adapter uses (so tests can mock it). */
export interface CyLike {
  add(defs: unknown[]): unknown;
  getElementById(id: string): {
    length: number;
    data(key?: string, value?: unknown): unknown;
    position(): { x: number; y: number };
    classes(c: string): unknown;
    remove(): unknown;
  };
  elements(): { remove(): unknown };
  nodes(): { boundingBox(): { x2: number; y1: number; y2: number }; length: number };
  layout(opts: Record<string, unknown>): { run(): unknown; one?(event: string, cb: () => void): unknown };
  batch(f: () => void): void;
}

export type LayoutKind = 'hierarchical' | 'force';

type Rel = GraphSnapshot['rels'][number];

export class GraphView {
  private current: GraphSnapshot | null = null;
  private onLayoutDone: (() => void) | undefined;
  /** Client-side highlights (e.g. provenance), kept across polls. */
  private readonly extra = new Map<string, Set<string>>();

  constructor(private readonly cy: CyLike) {}

  private classesOf(n: NodeDTO): string {
    const extra = [...this.extra].filter(([, ids]) => ids.has(n.id)).map(([cls]) => cls);
    return [n.subgraph, n.emphasis ?? '', ...extra].filter(Boolean).join(' ');
  }

  private nodeDef(n: NodeDTO, position?: { x: number; y: number }) {
    return { group: 'nodes', data: { id: n.id, label: n.caption, kind: n.labels[0] }, classes: this.classesOf(n), ...(position ? { position } : {}) };
  }

  private relDef(r: Rel, critical: Set<string>) {
    return {
      group: 'edges',
      data: { id: r.id, source: r.from, target: r.to, label: r.type },
      classes: critical.has(r.from) && critical.has(r.to) ? 'critical_path' : '',
    };
  }

  private static critical(s: GraphSnapshot) {
    return new Set(s.nodes.filter((n) => n.emphasis === 'critical_path').map((n) => n.id));
  }

  /** Adds `cls` to exactly these node ids (an empty list clears it). Survives polls. */
  highlight(cls: string, ids: string[]): void {
    this.extra.set(cls, new Set(ids));
    if (!this.current) return;
    this.cy.batch(() => {
      for (const n of this.current?.nodes ?? []) {
        const el = this.cy.getElementById(n.id);
        if (el.length > 0) el.classes(this.classesOf(n));
      }
    });
  }

  layoutDone(cb: () => void): void {
    this.onLayoutDone = cb;
  }

  /** Full rebuild and layout: only when the scene or the iteration changes. */
  reset(snapshot: GraphSnapshot, layout: LayoutKind): void {
    this.cy.batch(() => {
      this.cy.elements().remove();
      const critical = GraphView.critical(snapshot);
      this.cy.add([...snapshot.nodes.map((n) => this.nodeDef(n)), ...snapshot.rels.map((r) => this.relDef(r, critical))]);
    });
    this.current = snapshot;
    const run = this.cy.layout(
      layout === 'hierarchical'
        ? { name: 'dagre', rankDir: 'TB', nodeSep: 30, rankSep: 60, animate: false, fit: true, padding: 40 }
        : { name: 'fcose', animate: false, randomize: true, fit: true, padding: 40, quality: 'default' },
    );
    run.one?.('layoutstop', () => this.onLayoutDone?.());
    run.run();
  }

  /** Incremental update from a poll. Never re-lays-out. */
  update(snapshot: GraphSnapshot): void {
    const d = diffGraph(this.current, snapshot);
    this.cy.batch(() => {
      for (const id of [...d.removed.rels, ...d.removed.nodes]) this.cy.getElementById(id).remove();
      for (const n of d.updated) {
        const el = this.cy.getElementById(n.id);
        el.data('label', n.caption);
        el.classes(this.classesOf(n));
      }
      if (d.added.nodes.length + d.added.rels.length > 0) {
        const box = this.cy.nodes().length > 0 ? this.cy.nodes().boundingBox() : { x2: 0, y1: 0, y2: 0 };
        let spill = 0;
        const placed = d.added.nodes.map((n) => {
          // Next to a neighbor that is already on screen, else in a column to the right.
          const rel = snapshot.rels.find((r) => (r.from === n.id || r.to === n.id) && this.cy.getElementById(r.from === n.id ? r.to : r.from).length > 0);
          const anchor = rel ? this.cy.getElementById(rel.from === n.id ? rel.to : rel.from).position() : null;
          const position = anchor
            ? { x: anchor.x + 60 + Math.random() * 40, y: anchor.y + 70 }
            : { x: box.x2 + 120, y: box.y1 + 60 * spill++ };
          return this.nodeDef(n, position);
        });
        const critical = GraphView.critical(snapshot);
        this.cy.add([...placed, ...d.added.rels.map((r) => this.relDef(r, critical))]);
      }
    });
    this.current = snapshot;
  }
}
