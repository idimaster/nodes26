import neo4j, { type Driver } from 'neo4j-driver';
import { label as labelDef, ontology, type LabelDef } from '@planner/ontology';
import type { Dataset, NodeRef, Props, Rel, Value } from '@planner/data';

const BATCH = 1000;

/**
 * Labels, relationship types, and property names cannot be query parameters, so they are
 * spliced into the query text. They must come from config/ontology.json (or, for extra
 * properties, look like a plain identifier). Values always travel as parameters.
 */
function labelOf(name: string): LabelDef {
  const def = labelDef(name);
  if (!def) throw new Error(`label ${JSON.stringify(name)} is not in the ontology`);
  return def;
}

function relTypeOf(type: string): string {
  if (!ontology.relationships.some((r) => r.type === type)) {
    throw new Error(`relationship type ${JSON.stringify(type)} is not in the ontology`);
  }
  return type;
}

function propName(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`property name ${JSON.stringify(name)} is not a plain identifier`);
  return name;
}

/** Converts values to the ontology's types: integers become Neo4j integers (JS numbers are sent as floats). */
function toParams(def: LabelDef, props: Props): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[propName(k)] = def.types[k] === 'integer' ? neo4j.int(v as number) : (v satisfies Value);
  }
  return out;
}

const keyMap = (def: LabelDef, row: string): string =>
  `{${def.key.map((k) => `${propName(k)}: ${row}.${propName(k)}`).join(', ')}}`;

/** Datetime properties arrive as ISO strings and are stored as DATETIME. */
const datetimeSets = (def: LabelDef, variable: string, row: string): string =>
  Object.entries(def.types)
    .filter(([, t]) => t === 'datetime')
    .map(([p]) => `SET ${variable}.${propName(p)} = datetime(${row}.${propName(p)})`)
    .join('\n');

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

async function writeNodes(driver: Driver, labelName: string, rows: Props[]): Promise<number> {
  const def = labelOf(labelName);
  const query = `UNWIND $rows AS row
MERGE (n:${def.name} ${keyMap(def, 'row')})
SET n += row
${datetimeSets(def, 'n', 'row')}
RETURN count(n) AS written`;
  let total = 0;
  for (const batch of chunks(rows)) {
    const { records } = await driver.executeQuery(query, { rows: batch.map((r) => toParams(def, r)) });
    const written = neo4j.integer.toNumber(records[0]?.get('written'));
    if (written !== batch.length) throw new Error(`${def.name}: wrote ${written} of ${batch.length} nodes`);
    total += written;
  }
  return total;
}

const endpointParams = (ref: NodeRef): Record<string, unknown> => toParams(labelOf(ref.label), ref.key);

async function writeRelationships(driver: Driver, type: string, rels: Rel[]): Promise<number> {
  const relType = relTypeOf(type);
  // Group by endpoint labels: each group is one query shape.
  const groups = new Map<string, Rel[]>();
  for (const r of rels) {
    const k = `${r.from.label}->${r.to.label}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let total = 0;
  for (const [pair, group] of groups) {
    const from = labelOf(group[0]?.from.label ?? '');
    const to = labelOf(group[0]?.to.label ?? '');
    const query = `UNWIND $rows AS row
MATCH (a:${from.name} ${keyMap(from, 'row.a')})
MATCH (b:${to.name} ${keyMap(to, 'row.b')})
MERGE (a)-[r:${relType}]->(b)
SET r += row.props
RETURN count(r) AS written`;
    for (const batch of chunks(group)) {
      const rows = batch.map((r) => ({
        a: endpointParams(r.from),
        b: endpointParams(r.to),
        props: Object.fromEntries(Object.entries(r.props).map(([k, v]) => [propName(k), v])),
      }));
      const { records } = await driver.executeQuery(query, { rows });
      const written = neo4j.integer.toNumber(records[0]?.get('written'));
      if (written !== batch.length) {
        throw new Error(
          `${relType} ${pair}: ${batch.length - written} of ${batch.length} relationships have a missing endpoint ` +
            '(MATCH found no node); nothing is dropped silently',
        );
      }
      total += written;
    }
  }
  return total;
}

/** Writes a dataset: all nodes first (in ontology order), then all relationships. Idempotent (MERGE on keys). */
export async function writeDataset(driver: Driver, ds: Dataset): Promise<{ nodes: number; relationships: number }> {
  let nodes = 0;
  let relationships = 0;
  const labels = Object.keys(ds.nodes);
  for (const l of labels) labelOf(l);
  for (const def of ontology.labels) {
    const rows = ds.nodes[def.name];
    if (rows?.length) nodes += await writeNodes(driver, def.name, rows);
  }
  for (const [type, rels] of Object.entries(ds.relationships)) {
    if (rels.length) relationships += await writeRelationships(driver, type, rels);
  }
  return { nodes, relationships };
}
