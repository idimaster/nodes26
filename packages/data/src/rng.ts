/** mulberry32: small, fast, deterministic PRNG. Same seed, same sequence, on every platform. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: () => number, lo: number, hi: number): number => lo + (hi - lo) * r();
export const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits;
export function pick<T>(r: () => number, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

export function shuffle<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
