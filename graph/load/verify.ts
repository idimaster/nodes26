import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import neo4j, { type Driver } from 'neo4j-driver';
import { DATA_DIR, readDataset, validateDataset, manifestOf, type Manifest, type Props } from '@planner/data';
import { label, ontology } from '@planner/ontology';

export type VerificationMode = 'strict' | 'retain-active-global-terms';
export interface GraphNode { id: string; labels: string[]; props: Record<string, unknown> }
interface GraphEdge { from: string; to: string; type: string; props: Record<string, unknown> }
interface Constraint { labels: string[]; properties: string[]; type: string }
const read = { routing: neo4j.routing.READ };
function fail(message: string): never { throw new Error(`DATASET_NOT_READY: ${message}`); }

export function normalized(value: unknown): unknown {
  if (neo4j.isInt(value)) return value.toNumber();
  if (neo4j.isDateTime(value)) {
    // JS Date truncates nanoseconds; retain Neo4j's full precision in comparisons/snapshots.
    const seconds = Math.floor(new Date(value.toString()).getTime() / 1000);
    return new Date(seconds * 1000).toISOString().replace('.000Z', `.${String(value.nanosecond).padStart(9, '0')}Z`);
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v)]));
  return value;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
const identity = (name: string, props: Record<string, unknown>): string => {
  const def = label(name);
  if (!def) return fail(`unknown baseline label ${name}`);
  return `${name}:${stable(Object.fromEntries(def.key.map(k => [k, normalized(props[k])])) )}`;
};

async function snapshot(driver: Driver) {
  const n = await driver.executeQuery('MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props', {}, read);
  const r = await driver.executeQuery('MATCH (a)-[r]->(b) RETURN elementId(a) AS from, elementId(b) AS to, type(r) AS type, properties(r) AS props', {}, read);
  const c = await driver.executeQuery('SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type RETURN labelsOrTypes AS labels, properties, type', {}, read);
  return {
    nodes: n.records.map(row => row.toObject() as GraphNode),
    edges: r.records.map(row => row.toObject() as GraphEdge),
    constraints: c.records.map(row => row.toObject() as Constraint),
  };
}

function requireConstraint(constraints: Constraint[], name: string, key: string[]) {
  if (!constraints.some(c => c.type === 'NODE_PROPERTY_UNIQUENESS' && isDeepStrictEqual(c.labels, [name]) && isDeepStrictEqual(c.properties, key))) {
    fail(`missing uniqueness constraint for ${name}(${key.join(', ')})`);
  }
}

function validType(value: unknown, type: string): boolean {
  if (type === 'integer') return neo4j.isInt(value);
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'datetime') return neo4j.isDateTime(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  if (type === 'json') { try { JSON.parse(value); } catch { return false; } }
  return true;
}

function retained(nodes: GraphNode[], edges: GraphEdge[], constraints: Constraint[], allowEdges: boolean): GraphNode[] {
  const terms = nodes.filter(n => n.labels.includes('OntologyTerm'));
  const keys = new Set<string>();
  const core = new Set([...ontology.labels.map(l => l.name), ...ontology.relationships.map(r => r.type)].map(s => s.toLowerCase()));
  for (const term of terms) {
    const p = term.props;
    const key = `${String(p.kind)}/${String(p.name)}`;
    if (!isDeepStrictEqual(term.labels, ['OntologyTerm']) || p.scope !== 'global' || p.status !== 'active' || 'deal_code' in p || keys.has(key)) fail(`invalid retained term ${key}`);
    keys.add(key);
    const def = label('OntologyTerm');
    if (!def || Object.entries(def.types).some(([k, type]) => !validType(p[k], type))) fail(`invalid retained term property types: ${key}`);
    if (typeof p.name !== 'string' || core.has(p.name.toLowerCase()) || !(
      p.kind === 'label' ? /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$/.test(p.name) : p.kind === 'relationship' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(p.name)
    )) fail(`invalid retained term name/kind ${key}`);
    if (p.kind === 'label') requireConstraint(constraints, String(p.name), ['deal_code', 'id']);
    for (const edge of edges.filter(e => e.from === term.id || e.to === term.id)) {
      if (!allowEdges) fail(`unexpected retained term edge ${key}: ${edge.type}`);
      const other = nodes.find(n => n.id === (edge.from === term.id ? edge.to : edge.from));
      const legitimate = edge.from === term.id
        ? (edge.type === 'MOTIVATED_BY' && other?.labels.includes('Finding')) || (edge.type === 'APPROVED_BY' && other?.labels.includes('GateDecision'))
        : edge.type === 'DECIDED_ON' && other?.labels.includes('GateDecision');
      if (!legitimate) fail(`unexpected retained provenance ${key}: ${edge.type}`);
    }
  }
  return terms;
}

/** Pre-reset structural validation permits only the provenance that per-deal deletion removes. */
export async function snapshotRetainedTerms(driver: Driver): Promise<unknown[]> {
  const s = await snapshot(driver);
  // Scoped terms are reset with their deal; global terms must be valid before any deletion.
  return retained(s.nodes.filter(n => !n.labels.includes('OntologyTerm') || n.props.scope === 'global'), s.edges, s.constraints, true)
    .map(n => normalized(n.props)).sort((a, b) => stable(a).localeCompare(stable(b)));
}

/** Read-only positive verification. Never applies schema, reloads data, or trusts an earlier success. */
export async function verifyLoadedDataset(driver: Driver, options: { dir?: string; deal?: string; mode?: VerificationMode } = {}) {
  try {
    const dir = options.dir ?? DATA_DIR;
    const ds = readDataset(dir);
    const problems = validateDataset(ds);
    if (problems.length) fail(`invalid fixtures: ${problems.join('; ')}`);
    const expected = manifestOf(ds);
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (!isDeepStrictEqual(expected, manifest)) fail('fixture data is inconsistent with data/manifest.json');
    if (options.deal !== undefined && ds.nodes.Deal?.filter(p => p.code === options.deal).length !== 1) fail(`selected deal ${options.deal} must exist exactly once in fixtures`);
    const s = await snapshot(driver);
    for (const def of ontology.labels) requireConstraint(s.constraints, def.name, def.key);
    const extraTerms = options.mode === 'retain-active-global-terms' ? retained(s.nodes, s.edges, s.constraints, false) : [];
    const extraIds = new Set(extraTerms.map(t => t.id));
    const baseline = s.nodes.filter(n => !extraIds.has(n.id));
    const expectedNodes = new Map<string, Props>();
    for (const [name, rows] of Object.entries(ds.nodes)) for (const props of rows) {
      const key = identity(name, props);
      if (expectedNodes.has(key)) fail(`duplicate fixture node ${key}`);
      expectedNodes.set(key, props);
    }
    const byId = new Map<string, string>();
    const found = new Set<string>();
    for (const n of baseline) {
      if (n.labels.length !== 1) fail(`unexpected baseline labels ${n.labels.join(',')}`);
      const name = n.labels[0] ?? '';
      const key = identity(name, n.props);
      const props = expectedNodes.get(key);
      if (!props || found.has(key)) fail(`unexpected or duplicate node ${key}; graph does not match data/manifest.json`);
      found.add(key); byId.set(n.id, key);
      for (const [p, value] of Object.entries(props)) {
        const type = label(name)?.types[p];
        if (type && !validType(n.props[p], type)) fail(`${key}.${p}: wrong stored type (${type} required)`);
        const expectedValue = type === 'datetime' ? normalized(neo4j.types.DateTime.fromString(value as string)) : value;
        if (!isDeepStrictEqual(normalized(n.props[p]), expectedValue)) fail(`${key}.${p}: fixture property differs`);
      }
    }
    if (found.size !== expectedNodes.size) fail(`missing fixture nodes (${found.size}/${expectedNodes.size}); graph does not match data/manifest.json`);
    const edgeKey = (type: string, from: string, to: string) => stable([type, from, to]);
    const expectedEdges = new Map(Object.values(ds.relationships).flat().map(r => [edgeKey(r.type, identity(r.from.label, r.from.key), identity(r.to.label, r.to.key)), r.props]));
    const seen = new Set<string>();
    for (const r of s.edges) {
      const key = edgeKey(r.type, byId.get(r.from) ?? '', byId.get(r.to) ?? '');
      const props = expectedEdges.get(key);
      if (!props || seen.has(key)) fail(`unexpected or duplicate relationship ${key}`);
      for (const [p, value] of Object.entries(props)) if (!isDeepStrictEqual(normalized(r.props[p]), value)) fail(`relationship ${key}.${p} differs`);
      seen.add(key);
    }
    if (seen.size !== expectedEdges.size) fail(`missing fixture relationships (${seen.size}/${expectedEdges.size})`);
    const counts: Manifest = { nodes: {}, relationships: {} };
    for (const n of s.nodes) for (const l of n.labels) counts.nodes[l] = (counts.nodes[l] ?? 0) + 1;
    for (const r of s.edges) counts.relationships[r.type] = (counts.relationships[r.type] ?? 0) + 1;
    const baselineCounts: Manifest = { nodes: { ...counts.nodes }, relationships: { ...counts.relationships } };
    if (extraTerms.length) delete baselineCounts.nodes.OntologyTerm;
    if (!isDeepStrictEqual(baselineCounts, expected)) fail('baseline counts do not match data/manifest.json');
    return { physicalCounts: counts, baselineCounts, retainedTerms: extraTerms.map(t => `${String(t.props.kind)}/${String(t.props.name)}`).sort() };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DATASET_NOT_READY:')) throw error;
    return fail(`verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
