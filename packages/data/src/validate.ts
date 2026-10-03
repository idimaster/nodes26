import { label as labelDef, ontology, type PropertyType } from '@planner/ontology';
import { keyString, must, type Dataset, type Props, type Scalar, type Value } from './types.js';

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeError(type: PropertyType, v: Value): string | undefined {
  switch (type) {
    case 'string':
      return typeof v === 'string' ? undefined : 'must be a string';
    case 'integer':
      return Number.isInteger(v) ? undefined : 'must be an integer';
    case 'float':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : 'must be a finite number';
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'must be a boolean';
    case 'datetime':
      return typeof v === 'string' && ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v))
        ? undefined
        : 'must be an ISO-8601 datetime string';
    case 'json':
      if (typeof v !== 'string') return 'must be a JSON string';
      try {
        JSON.parse(v);
        return undefined;
      } catch {
        return 'must be valid JSON';
      }
  }
}

/** Neo4j properties: scalars, or homogeneous arrays of scalars. */
function storable(v: Value): boolean {
  if (!Array.isArray(v)) return ['string', 'number', 'boolean'].includes(typeof v);
  return v.every((x) => typeof x === typeof v[0]);
}

const nodeId = (labelName: string, keyProps: string[], props: Props): string =>
  `${labelName} ${keyString(Object.fromEntries(keyProps.map((k) => [k, props[k] as Scalar])))}`;

/** Validates every node and relationship against config/ontology.json. Returns problems; empty means valid. */
export function validateDataset(ds: Dataset): string[] {
  const problems: string[] = [];
  const index = new Map<string, Set<string>>();

  for (const [labelName, list] of Object.entries(ds.nodes)) {
    const def = labelDef(labelName);
    if (!def) {
      problems.push(`unknown label ${labelName}`);
      continue;
    }
    const keys = new Set<string>();
    index.set(labelName, keys);
    for (const props of list) {
      const where = nodeId(labelName, def.key, props);
      for (const p of [...def.key, ...def.required]) {
        const v = props[p];
        if (v === undefined) {
          problems.push(`${where}: missing ${p}`);
          continue;
        }
        const err = typeError(must(def.types[p], `type of ${labelName}.${p}`), v);
        if (err) problems.push(`${where}: ${p} ${err}`);
        const allowed = def.enums[p];
        if (allowed && !allowed.includes(String(v))) {
          problems.push(`${where}: ${p} '${String(v)}' is not one of {${allowed.join(', ')}}`);
        }
      }
      for (const [p, v] of Object.entries(props)) {
        if (!storable(v)) problems.push(`${where}: ${p} is not a storable property value`);
      }
      const k = keyString(Object.fromEntries(def.key.map((p) => [p, props[p] as Scalar])));
      if (keys.has(k)) problems.push(`${where}: duplicate key`);
      keys.add(k);
    }
  }

  for (const [type, list] of Object.entries(ds.relationships)) {
    const def = ontology.relationships.find((r) => r.type === type);
    if (!def) {
      problems.push(`unknown relationship type ${type}`);
      continue;
    }
    for (const r of list) {
      const where = `${type} ${r.from.label}${keyString(r.from.key)}->${r.to.label}${keyString(r.to.key)}`;
      const allowed = def.endpoints.some((e) => e.from.includes(r.from.label) && e.to.includes(r.to.label));
      if (!allowed) problems.push(`${where}: endpoint ${r.from.label}->${r.to.label} is not allowed by the ontology`);
      for (const end of [r.from, r.to]) {
        const endDef = labelDef(end.label);
        if (!endDef) continue;
        const keyProps = Object.keys(end.key);
        if (keyProps.join() !== endDef.key.join()) {
          problems.push(`${where}: ${end.label} must be referenced by its key (${endDef.key.join(', ')})`);
        } else if (!index.get(end.label)?.has(keyString(end.key))) {
          problems.push(`${where}: target ${end.label}${keyString(end.key)} does not exist`);
        }
      }
      for (const p of def.properties) {
        if (r.props[p] === undefined) problems.push(`${where}: missing relationship property ${p}`);
      }
    }
  }
  return problems;
}
