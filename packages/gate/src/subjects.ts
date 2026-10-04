/**
 * Gate subjects are typed references, resolved within a deal and iteration (DESIGN §4):
 *   Selection:<uc>  FramedUseCase:<id>  PlanTask:<id>  Candidate:<uc>/<pattern>
 *   Iteration:<n>  Roadmap:<version>  CapabilityDecision:<capability_id>  OntologyTerm:<kind>/<name>
 */

export interface SubjectRef {
  label: string;
  key: Record<string, string | number>;
}

/** Labels a gate may decide on; the values build the key from the reference text. */
const PARSERS: Record<string, (rest: string, deal: string, iteration: number) => Record<string, string | number> | null> = {
  Selection: (r, d, it) => ({ deal_code: d, iteration: it, uc: r }),
  FramedUseCase: (r, d, it) => ({ deal_code: d, iteration: it, id: r }),
  PlanTask: (r, d, it) => ({ deal_code: d, iteration: it, id: r }),
  CapabilityDecision: (r, d, it) => ({ deal_code: d, iteration: it, capability_id: r }),
  Candidate: (r, d, it) => {
    const [uc, pattern, extra] = r.split('/');
    return uc && pattern && extra === undefined ? { deal_code: d, iteration: it, uc, pattern } : null;
  },
  Iteration: (r, d) => (/^[1-9][0-9]*$/.test(r) ? { deal_code: d, n: Number(r) } : null),
  Roadmap: (r, d) => (/^[1-9][0-9]*$/.test(r) ? { deal_code: d, version: Number(r) } : null),
  // Terms resolve only within the deal's own scope: a gate never touches another deal's term.
  OntologyTerm: (r, d) => {
    const [kind, name, extra] = r.split('/');
    return (kind === 'label' || kind === 'relationship') && name && extra === undefined ? { kind, name, scope: d } : null;
  },
};

export const SUBJECT_LABELS = Object.keys(PARSERS);

export function parseSubject(ref: string, deal: string, iteration: number): SubjectRef {
  const colon = ref.indexOf(':');
  const label = colon === -1 ? ref : ref.slice(0, colon);
  const rest = colon === -1 ? '' : ref.slice(colon + 1);
  const parse = Object.hasOwn(PARSERS, label) ? PARSERS[label] : undefined;
  if (!parse) throw new Error(`subject ${JSON.stringify(ref)}: a gate can decide on ${SUBJECT_LABELS.join(', ')}`);
  const key = rest === '' ? null : parse(rest, deal, iteration);
  if (!key) throw new Error(`subject ${JSON.stringify(ref)} is malformed (see DESIGN §4 subject references)`);
  return { label, key };
}
