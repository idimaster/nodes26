/**
 * The comment grammar of DESIGN §4. A reviewer's comment always becomes Feedback; lines or
 * sentences that match this grammar (with an existing pattern or use-case id) also become Overrides.
 */

export type OverrideKind =
  | 'exclude_pattern'
  | 'pin_pattern'
  | 'include_use_case'
  | 'exclude_use_case'
  | 'strategy_for'
  | 'directive';

export interface ParsedOverride {
  kind: OverrideKind;
  /** Pattern or use-case id ('' for a directive). */
  subject: string;
  /** Strategy for strategy_for, text for directive, otherwise ''. */
  value: string;
}

export interface Catalog {
  patterns: Set<string>;
  useCases: Set<string>;
}

const ID = '([a-z0-9][a-z0-9-]*)';

function parseSentence(sentence: string, c: Catalog): ParsedOverride | null {
  const s = sentence.trim().toLowerCase();
  let m = new RegExp(`^(?:remove|except)\\s+${ID}$`).exec(s);
  if (m) {
    const id = m[1] as string;
    if (c.patterns.has(id)) return { kind: 'exclude_pattern', subject: id, value: '' };
    if (c.useCases.has(id)) return { kind: 'exclude_use_case', subject: id, value: '' };
    return null;
  }
  m = new RegExp(`^keep\\s+${ID}$`).exec(s);
  if (m) return c.patterns.has(m[1] as string) ? { kind: 'pin_pattern', subject: m[1] as string, value: '' } : null;
  m = new RegExp(`^include\\s+${ID}$`).exec(s);
  if (m) return c.useCases.has(m[1] as string) ? { kind: 'include_use_case', subject: m[1] as string, value: '' } : null;
  m = new RegExp(`^use\\s+(bridge|transform)\\s+for\\s+${ID}$`).exec(s);
  if (m) {
    const id = m[2] as string;
    return c.patterns.has(id) || c.useCases.has(id) ? { kind: 'strategy_for', subject: id, value: m[1] as string } : null;
  }
  return null;
}

export function parseOverrides(comment: string, catalog: Catalog): ParsedOverride[] {
  const out: ParsedOverride[] = [];
  const push = (o: ParsedOverride | null) => {
    if (o && !out.some((x) => x.kind === o.kind && x.subject === o.subject && x.value === o.value)) out.push(o);
  };
  for (const line of comment.split('\n')) {
    const directive = /^\s*directive:\s*(.+?)\s*$/i.exec(line);
    if (directive) {
      push({ kind: 'directive', subject: '', value: directive[1] as string });
      continue;
    }
    for (const sentence of line.split(/[.;!?]+/)) push(parseSentence(sentence, catalog));
  }
  return out;
}
