import type { Thresholds } from './thresholds.js';

export type FindingKind = 'capability' | 'gap' | 'risk' | 'assumption' | 'service';

export interface FindingEvidence {
  id: string;
  kind: string;
  evidence_type: string;
  confidence: number;
}

export function isStrong(f: FindingEvidence, th: Thresholds): boolean {
  return th.classify.strong_evidence.includes(f.evidence_type) && f.confidence >= th.classify.min_confidence;
}

/** DESIGN §2.1: gaps and capabilities need strong evidence; otherwise they are assumptions. */
export function classifyFinding(f: FindingEvidence, th: Thresholds): FindingKind {
  switch (f.kind) {
    case 'gap':
    case 'assumption':
      return isStrong(f, th) ? 'gap' : 'assumption';
    case 'capability':
      return isStrong(f, th) ? 'capability' : 'assumption';
    case 'risk':
    case 'service':
      return f.kind;
    default:
      throw new Error(`unknown finding kind ${JSON.stringify(f.kind)} on ${f.id}`);
  }
}
