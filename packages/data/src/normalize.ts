import type { z } from 'zod';
import type {
  buildOptionsFile,
  capabilityTypesFile,
  dealFile,
  patternsFile,
  platformCapabilitiesFile,
  strategiesFile,
  tracksFile,
  useCasesFile,
} from './authoring.js';
import { addNode, addRel, emptyDataset, type Dataset, type NodeRef } from './types.js';

export interface Catalog {
  strategies: z.infer<typeof strategiesFile>;
  tracks: z.infer<typeof tracksFile>;
  useCases: z.infer<typeof useCasesFile>;
  capabilityTypes: z.infer<typeof capabilityTypesFile>;
  buildOptions: z.infer<typeof buildOptionsFile>;
  platformCapabilities: z.infer<typeof platformCapabilitiesFile>;
  patterns: z.infer<typeof patternsFile>;
}

export const ref = (label: string, id: string): NodeRef => ({ label, key: { id } });
export const dealRef = (label: string, deal: string, id: string): NodeRef => ({ label, key: { deal_code: deal, id } });
export const taskId = (pattern: string, task: string): string => `${pattern}.${task}`;

const weeksProps = ([o, e, p]: readonly [number, number, number]) => ({ weeks_o: o, weeks_e: e, weeks_p: p });

export function normalizeCatalog(c: Catalog): Dataset {
  const ds = emptyDataset();
  for (const s of c.strategies) addNode(ds, 'Strategy', { id: s.id, description: s.description });
  for (const t of c.tracks) addNode(ds, 'Track', { id: t.id, name: t.name, order: t.order });
  for (const u of c.useCases) addNode(ds, 'UseCase', { id: u.id, display: u.display, description: u.description });
  for (const t of c.capabilityTypes) addNode(ds, 'CapabilityType', { id: t.id, name: t.name });

  for (const b of c.buildOptions) {
    addNode(ds, 'BuildOption', { id: b.id, ...weeksProps(b.weeks), confidence: b.confidence, source: b.source });
    addRel(ds, 'DELIVERS', ref('BuildOption', b.id), ref('CapabilityType', b.delivers));
  }

  for (const p of c.platformCapabilities) {
    addNode(ds, 'PlatformCapability', { id: p.id, name: p.name });
    for (const pr of p.provides) {
      addRel(ds, 'PROVIDES', ref('PlatformCapability', p.id), ref('CapabilityType', pr.capability), {
        coverage: pr.coverage,
      });
    }
  }

  for (const p of c.patterns) {
    addNode(ds, 'Pattern', {
      id: p.id,
      name: p.name,
      description: p.description,
      reference: p.reference,
      ...(p.not_recommended_when.length > 0 ? { not_recommended_when: p.not_recommended_when } : {}),
    });
    const pat = ref('Pattern', p.id);
    addRel(ds, 'IN_TRACK', pat, ref('Track', p.track));
    for (const s of p.strategies) addRel(ds, 'APPLIES_TO', pat, ref('Strategy', s));
    for (const u of p.solves) addRel(ds, 'SOLVES', pat, ref('UseCase', u));
    for (const [type, targets] of [
      ['REQUIRES', p.requires],
      ['CONFLICTS', p.conflicts],
      ['AUGMENTS', p.augments],
      ['SUPERSEDES', p.supersedes],
    ] as const) {
      for (const t of targets) addRel(ds, type, pat, ref('Pattern', t));
    }
    for (const t of p.tasks) {
      const id = taskId(p.id, t.id);
      addNode(ds, 'Task', { id, summary: t.summary, ...weeksProps(t.weeks), skill: t.skill });
      addRel(ds, 'HAS_TASK', pat, ref('Task', id));
      for (const d of t.depends_on) addRel(ds, 'DEPENDS_ON', ref('Task', id), ref('Task', taskId(p.id, d)));
    }
  }
  return ds;
}

export function normalizeDeal(d: z.infer<typeof dealFile>): Dataset {
  const ds = emptyDataset();
  const code = d.deal.code;
  addNode(ds, 'Deal', { ...d.deal });
  for (const s of d.sources) addNode(ds, 'Source', { deal_code: code, id: s.id, type: s.type, uri: s.uri });
  for (const f of d.findings) {
    addNode(ds, 'Finding', {
      deal_code: code,
      id: f.id,
      kind: f.kind,
      text: f.text,
      severity: f.severity,
      confidence: f.confidence,
      evidence_type: f.evidence_type,
    });
    const fr = dealRef('Finding', code, f.id);
    addRel(ds, 'HAS_FINDING', { label: 'Deal', key: { code } }, fr);
    for (const s of f.sources) addRel(ds, 'SUPPORTED_BY', fr, dealRef('Source', code, s));
    if (f.is_a) addRel(ds, 'IS_A', fr, ref('CapabilityType', f.is_a));
    for (const c of f.calls) addRel(ds, 'CALLS', fr, dealRef('Finding', code, c));
  }
  return ds;
}
