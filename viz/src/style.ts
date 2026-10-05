import type { StylesheetJson } from 'cytoscape';

/** The deck palette (T4.2 addendum §5.1). Also used by browser/style.grass. */
export const PALETTE = {
  knowledge: '#9DB8C7',
  evidence: '#FF9A7A',
  plan: '#8EE3EA',
  decisions: '#B79CFF',
  ontology: '#F4C25A',
  witness: '#FF5C5C',
  provenance: '#2EE6FF',
  bg: '#002B43',
} as const;

export const graphStyle: StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      color: '#E8F1F5',
      'font-size': 14,
      'text-valign': 'bottom',
      'text-margin-y': 6,
      'text-wrap': 'wrap',
      'text-max-width': '160px',
      width: 26,
      height: 26,
      'border-width': 0,
      'background-color': PALETTE.knowledge,
    },
  },
  ...(['knowledge', 'evidence', 'plan', 'decisions', 'ontology'] as const).map((s) => ({
    selector: `node.${s}`,
    style: { 'background-color': PALETTE[s] },
  })),
  { selector: 'node.draft', style: { 'background-opacity': 0.55 } },
  { selector: 'node.critical_path', style: { 'border-width': 4, 'border-color': '#FFFFFF' } },
  { selector: 'node.witness', style: { 'background-color': PALETTE.witness, 'border-width': 4, 'border-color': PALETTE.witness } },
  { selector: 'node.provenance', style: { 'border-width': 5, 'border-color': PALETTE.provenance } },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#4F7388',
      'target-arrow-color': '#4F7388',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 0.8,
    },
  },
  { selector: 'edge.critical_path', style: { width: 4, 'line-color': '#FFFFFF', 'target-arrow-color': '#FFFFFF' } },
];
