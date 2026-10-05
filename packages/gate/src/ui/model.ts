import { createHash } from 'node:crypto';
import { ontology } from '@planner/ontology';

/** Graph DTOs for the demo UI (T4.2 addendum, Step 3): computed server-side, so the page stays dumb. */

export interface RawNode {
  elementId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export type Subgraph = 'knowledge' | 'evidence' | 'plan' | 'decisions' | 'ontology';
export type Emphasis = 'witness' | 'critical_path' | 'draft';

export interface NodeDTO {
  id: string;
  labels: string[];
  subgraph: Subgraph;
  caption: string;
  status?: string;
  emphasis?: Emphasis;
}

export interface RelDTO {
  id: string;
  from: string;
  to: string;
  type: string;
}

const SUBGRAPH = new Map<string, Subgraph>(
  ontology.labels.map((l) => [l.name, l.subgraph === 'meta' ? 'ontology' : (l.subgraph as Subgraph)]),
);
const MAX_CAPTION = 28;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const fit = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 10) / 10) : str(v));
const ellipsize = (s: string) => (s.length <= MAX_CAPTION ? s : `${s.slice(0, MAX_CAPTION - 1).trimEnd()}…`);

/** Labels outside the core ontology are instances of approved terms. */
export const subgraphOf = (labels: string[]): Subgraph => SUBGRAPH.get(labels[0] ?? '') ?? 'ontology';

export function captionOf(labels: string[], p: Record<string, unknown>): string {
  const caption = (() => {
    switch (labels[0]) {
      case 'Pattern':
        return str(p.name);
      case 'Task':
      case 'PlanTask':
        return str(p.summary) || str(p.task_id) || str(p.id);
      case 'Finding':
        return `${str(p.kind)}: ${str(p.text)}`;
      case 'FramedUseCase':
        return str(p.use_case_id);
      case 'Selection':
        return `${str(p.uc)} → ${str(p.pattern)}`;
      case 'Candidate':
        return `${str(p.pattern)} (${fit(p.fit_score)})`;
      case 'GateDecision':
        return `${str(p.gate)}: ${str(p.status)}`;
      case 'Feedback':
        return str(p.text);
      case 'Override':
        return `${str(p.kind)} ${str(p.subject)}`;
      case 'OntologyTerm':
        return str(p.name);
      case 'CapabilityDecision':
        return `${str(p.capability_id)}: ${str(p.outcome)}`;
      case 'Iteration':
        return `iteration ${str(p.n)}`;
      case 'Roadmap':
        return `roadmap v${str(p.version)}`;
      default:
        return str(p.name) || str(p.display) || str(p.id) || str(p.code) || (labels[0] ?? '');
    }
  })();
  return ellipsize(caption.replace(/\s+/g, ' ').trim());
}

export function emphasisOf(n: RawNode, witness: Set<string>): Emphasis | undefined {
  if (witness.has(n.elementId)) return 'witness';
  if (n.labels.includes('PlanTask') && n.properties.on_critical_path === true) return 'critical_path';
  if (n.properties.status === 'draft') return 'draft';
  return undefined;
}

export function toNodeDTO(n: RawNode, witness: Set<string>): NodeDTO {
  const dto: NodeDTO = { id: n.elementId, labels: n.labels, subgraph: subgraphOf(n.labels), caption: captionOf(n.labels, n.properties) };
  if (typeof n.properties.status === 'string') dto.status = n.properties.status;
  const e = emphasisOf(n, witness);
  if (e) dto.emphasis = e;
  return dto;
}

/** Keeps nodes by group priority (first group first) up to max, dropping duplicates. */
export function truncate(groups: RawNode[][], max: number): { nodes: RawNode[]; truncated: boolean } {
  const seen = new Set<string>();
  const nodes: RawNode[] = [];
  let truncated = false;
  for (const group of groups) {
    for (const n of group) {
      if (seen.has(n.elementId)) continue;
      seen.add(n.elementId);
      if (nodes.length >= max) {
        truncated = true;
        continue;
      }
      nodes.push(n);
    }
  }
  return { nodes, truncated };
}

/** Stable hash of what the page shows: node ids with status, fit_score, on_critical_path, and relationship ids. */
export function versionOf(nodes: RawNode[], relIds: string[]): string {
  const parts = nodes
    .map((n) => `${n.elementId}|${str(n.properties.status)}|${str(n.properties.fit_score)}|${str(n.properties.on_critical_path)}`)
    .sort();
  return createHash('sha1').update(parts.join('\n')).update('\n--\n').update([...relIds].sort().join('\n')).digest('hex').slice(0, 16);
}
