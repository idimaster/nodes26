import { readFileSync } from 'node:fs';
import neo4j, { type Driver, type Node } from 'neo4j-driver';
import { toNodeDTO, truncate, versionOf, type NodeDTO, type RawNode, type RelDTO } from './model.js';
import { plain, readQuery } from './read.js';

export const MAX_SCENE_NODES = 150;
const file = (name: string) => readFileSync(new URL(`./scenes/${name}.cypher`, import.meta.url), 'utf8');
const SCENES: Record<1 | 2 | 3, string> = { 1: file('scene1-knowledge'), 2: file('scene2-plan'), 3: file('scene3-decisions') };
const RELATIONSHIPS = file('relationships');

export interface SceneData {
  nodes: RawNode[];
  rels: RelDTO[];
  truncated: boolean;
  version: string;
}

const raw = (n: Node): RawNode => ({ elementId: n.elementId, labels: n.labels, properties: plain(n.properties) as Record<string, unknown> });

/** Nodes (by scene priority, capped) and the relationships among them, plus their version. */
export async function loadScene(driver: Driver, deal: string, iteration: number, scene: 1 | 2 | 3): Promise<SceneData> {
  const [row] = await readQuery(driver, SCENES[scene], { deal, iteration: neo4j.int(iteration) });
  const groups = ((row?.get('groups') as Node[][] | undefined) ?? []).map((g) => g.filter(Boolean).map(raw));
  const { nodes, truncated } = truncate(groups, MAX_SCENE_NODES);
  const ids = nodes.map((n) => n.elementId);
  const rels = (await readQuery(driver, RELATIONSHIPS, { ids })).map((r) => ({
    id: r.get('id') as string,
    from: r.get('from') as string,
    to: r.get('to') as string,
    type: r.get('type') as string,
  }));
  return { nodes, rels, truncated, version: versionOf(nodes, rels.map((r) => r.id)) };
}

export interface GraphResponse {
  version: string;
  nodes: NodeDTO[];
  rels: RelDTO[];
  witness: { check: string; eids: string[] } | null;
  truncated: boolean;
}

export const toResponse = (s: SceneData, witness: GraphResponse['witness']): GraphResponse => {
  const set = new Set(witness?.eids ?? []);
  return { version: s.version, nodes: s.nodes.map((n) => toNodeDTO(n, set)), rels: s.rels, witness, truncated: s.truncated };
};
