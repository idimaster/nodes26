export type Scalar = string | number | boolean;
export type Value = Scalar | Scalar[];
export type Props = Record<string, Value>;

/** A node identified by its label and its key properties (DESIGN §1.1). */
export interface NodeRef {
  label: string;
  key: Record<string, Scalar>;
}

export interface Rel {
  type: string;
  from: NodeRef;
  to: NodeRef;
  props: Props;
}

/**
 * The normalized form every data file reduces to, and what the loaders write.
 * Node and relationship lists keep file order, so serialization is deterministic.
 */
export interface Dataset {
  nodes: Record<string, Props[]>;
  relationships: Record<string, Rel[]>;
}

export const emptyDataset = (): Dataset => ({ nodes: {}, relationships: {} });

export function addNode(ds: Dataset, label: string, props: Props): void {
  (ds.nodes[label] ??= []).push(props);
}

export function addRel(ds: Dataset, type: string, from: NodeRef, to: NodeRef, props: Props = {}): void {
  (ds.relationships[type] ??= []).push({ type, from, to, props });
}

export function merge(...parts: Dataset[]): Dataset {
  const out = emptyDataset();
  for (const part of parts) {
    for (const [label, list] of Object.entries(part.nodes)) for (const n of list) addNode(out, label, n);
    for (const [type, list] of Object.entries(part.relationships)) for (const r of list) addRel(out, type, r.from, r.to, r.props);
  }
  return out;
}

export const nodes = (ds: Dataset, label: string): Props[] => ds.nodes[label] ?? [];
export const relationships = (ds: Dataset, type: string): Rel[] => ds.relationships[type] ?? [];

export const keyString = (key: Record<string, Scalar>): string =>
  `{${Object.entries(key)
    .map(([k, v]) => `${k}:${String(v)}`)
    .join(',')}}`;

/** Unwraps a value that must exist; throws with a useful message instead of failing later on undefined. */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
