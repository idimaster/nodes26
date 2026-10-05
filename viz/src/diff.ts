/** Graph snapshots from /api/graph and the diff between two of them (T4.2 addendum §5.1). Pure. */

export type Subgraph = 'knowledge' | 'evidence' | 'plan' | 'decisions' | 'ontology';

export interface NodeDTO {
  id: string;
  labels: string[];
  subgraph: Subgraph;
  caption: string;
  status?: string;
  emphasis?: 'witness' | 'critical_path' | 'draft';
}

export interface RelDTO {
  id: string;
  from: string;
  to: string;
  type: string;
}

export interface GraphSnapshot {
  nodes: NodeDTO[];
  rels: RelDTO[];
}

export interface GraphDiff {
  added: { nodes: NodeDTO[]; rels: RelDTO[] };
  updated: NodeDTO[];
  removed: { nodes: string[]; rels: string[] };
}

const shown = (n: NodeDTO) => `${n.caption}|${n.emphasis ?? ''}|${n.status ?? ''}`;

export function diffGraph(before: GraphSnapshot | null, after: GraphSnapshot): GraphDiff {
  const prevNodes = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const prevRels = new Set((before?.rels ?? []).map((r) => r.id));
  const nextNodes = new Set(after.nodes.map((n) => n.id));
  const nextRels = new Set(after.rels.map((r) => r.id));
  return {
    added: { nodes: after.nodes.filter((n) => !prevNodes.has(n.id)), rels: after.rels.filter((r) => !prevRels.has(r.id)) },
    updated: after.nodes.filter((n) => {
      const p = prevNodes.get(n.id);
      return p !== undefined && shown(p) !== shown(n);
    }),
    removed: {
      nodes: [...prevNodes.keys()].filter((id) => !nextNodes.has(id)),
      rels: [...prevRels].filter((id) => !nextRels.has(id)),
    },
  };
}
