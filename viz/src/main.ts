import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';
import type { GraphSnapshot } from './diff.js';
import { GraphView, type CyLike } from './graph-view.js';
import { graphStyle } from './style.js';
import './styles.css';

/** The demo page (T4.2): graph, gate panel, tables. Talks only to the gate server's /api. */

cytoscape.use(dagre);
cytoscape.use(fcose);

type Scene = 1 | 2 | 3;
interface GraphResponse extends GraphSnapshot {
  version: string;
  witness: { check: string; eids: string[] } | null;
  truncated: boolean;
}
interface Gate {
  id: string;
  deal_code: string;
  iteration: number;
  gate: string;
  summary: string;
  details: { candidates?: { pattern: string; fit_score: number }[]; provenance_eids?: string[] } | null;
  subjects: { title: string; label: string; fit_score?: number | null }[];
}
type Table = { status: 'ok'; columns: string[]; rows: unknown[][] } | { status: 'unavailable'; reason: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const state = {
  deal: params.get('deal') ?? 'nimbus',
  scene: (Number(params.get('scene')) || 2) as Scene,
  iteration: 0,
  follow: params.get('follow') !== 'off',
  version: '',
  witnessKey: '',
  inFlight: false,
  /** Ids of the rendered gate cards; null forces a re-render. */
  pendingIds: null as string | null,
};
const POLL_MS = Number(params.get('poll')) || 2000;

const cy = cytoscape({ container: $('graph'), style: graphStyle, wheelSensitivity: 0.3, minZoom: 0.1, maxZoom: 3 });
const view = new GraphView(cy as unknown as CyLike);
let layoutDone = false;
view.layoutDone(() => (layoutDone = true));
// For the Playwright E2E: read positions and layout state.
Object.assign(window, { __demo: { cy, isLayoutDone: () => layoutDone, state } });

const getJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
};

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 4000);
}

function status(text: string) {
  $('status').textContent = text;
}

/** Zooms to the given nodes for 3 s, then restores the previous viewport. */
function spotlight(ids: string[]) {
  const nodes = cy.collection();
  for (const id of ids) nodes.merge(cy.getElementById(id));
  if (nodes.length === 0) return;
  const zoom = cy.zoom();
  const pan = { ...cy.pan() };
  cy.animate({ fit: { eles: nodes, padding: 120 }, duration: 400 });
  window.setTimeout(() => cy.animate({ zoom, pan, duration: 400 }), 3000);
}

// ---------- iterations and scenes ----------

async function refreshIterations() {
  const its = await getJson<{ n: number; status: string }[]>(`/api/iterations?deal=${encodeURIComponent(state.deal)}`);
  const select = $<HTMLSelectElement>('iteration');
  const current = its.map((i) => String(i.n)).join(',');
  if (select.dataset.items !== current) {
    select.replaceChildren(...its.map((i) => new Option(`${i.n} (${i.status})`, String(i.n))));
    select.dataset.items = current;
  }
  const latest = its[0]?.n ?? 0;
  if ((state.follow || state.iteration === 0) && latest !== state.iteration) switchTo({ iteration: latest });
  select.value = String(state.iteration);
}

function switchTo(change: { scene?: Scene; iteration?: number }) {
  if (change.scene !== undefined) state.scene = change.scene;
  if (change.iteration !== undefined) state.iteration = change.iteration;
  state.version = ''; // forces a full reset on the next poll
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-scene]')) b.classList.toggle('on', Number(b.dataset.scene) === state.scene);
  void poll();
}

async function refreshGraph() {
  if (state.iteration === 0) {
    status('No iterations yet. Start the planner.');
    return;
  }
  const g = await getJson<GraphResponse>(`/api/graph?deal=${encodeURIComponent(state.deal)}&iteration=${state.iteration}&scene=${state.scene}`);
  if (g.version === state.version) return;
  const fresh = state.version === '';
  state.version = g.version;
  if (fresh) {
    layoutDone = false;
    view.reset(g, state.scene === 2 ? 'hierarchical' : 'force');
  } else view.update(g);
  const key = g.witness ? `${g.witness.check}:${[...g.witness.eids].sort().join(',')}` : '';
  if (key !== state.witnessKey) {
    state.witnessKey = key;
    if (g.witness && g.witness.eids.length > 0) {
      toast(`Validator ${g.witness.check} failed: witness highlighted`);
      spotlight(g.witness.eids);
    }
  }
  status(`${g.nodes.length} nodes${g.truncated ? ' (truncated)' : ''} · scene ${state.scene} · iteration ${state.iteration}`);
}

// ---------- gates ----------

/** Optional new-gate cue, off by default (?sound=on, the page's form of GATE_SOUND=on). */
function beep() {
  if (params.get('sound') !== 'on') return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // audio is best-effort
  }
}

const drafts = new Map<string, string>();

function gateCard(g: Gate): HTMLElement {
  const tpl = $<HTMLTemplateElement>('gate-card').content.firstElementChild as HTMLElement;
  const card = tpl.cloneNode(true) as HTMLElement;
  card.setAttribute('aria-label', `Gate ${g.id}`);
  card.dataset.gateId = g.id;
  (card.querySelector('.gate') as HTMLElement).textContent = g.gate;
  (card.querySelector('.chip') as HTMLElement).textContent = `${g.deal_code} · iteration ${g.iteration}`;
  (card.querySelector('.summary') as HTMLElement).textContent = g.summary;
  const list = card.querySelector('.subjects') as HTMLElement;
  for (const s of g.subjects) {
    const li = document.createElement('li');
    li.textContent = `${s.title}${s.fit_score != null ? ` · fit ${s.fit_score}` : ''} (${s.label})`;
    list.append(li);
  }
  const details = card.querySelector('.details') as HTMLElement;
  if (g.details?.candidates?.length) {
    details.append(`Candidates: ${g.details.candidates.map((c) => `${c.pattern} (${c.fit_score})`).join(', ')}`);
  }
  const prov = g.details?.provenance_eids ?? [];
  if (prov.length > 0) {
    const a = document.createElement('button');
    a.className = 'link';
    a.textContent = `Show provenance (${prov.length})`;
    a.onclick = () => {
      view.highlight('provenance', prov);
      spotlight(prov);
      window.setTimeout(() => view.highlight('provenance', []), 6000);
    };
    details.append(' ', a);
  }
  const comment = card.querySelector('textarea') as HTMLTextAreaElement;
  comment.setAttribute('aria-label', `Comment for ${g.id}`);
  comment.value = drafts.get(g.id) ?? '';
  comment.addEventListener('input', () => drafts.set(g.id, comment.value));
  const error = card.querySelector('.error') as HTMLElement;
  const buttons = [...card.querySelectorAll<HTMLButtonElement>('.actions button')];
  const act = (action: 'approve' | 'approve_except' | 'reject') => async () => {
    error.textContent = '';
    if (action === 'reject' && comment.value.trim() === '') {
      error.textContent = 'A rejection needs a comment.';
      comment.focus();
      return;
    }
    for (const b of buttons) b.disabled = true;
    try {
      const res = await fetch(`/api/gates/${encodeURIComponent(g.id)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, comment: comment.value, by: $<HTMLInputElement>('by').value || 'architect' }),
      });
      if (res.ok || res.status === 409) {
        drafts.delete(g.id);
        if (res.status === 409) toast('Already decided.');
        state.pendingIds = null;
        await refreshGates();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      error.textContent = body.message ?? `Request failed (${res.status})`;
    } catch {
      error.textContent = 'Cannot reach the gate server.';
    }
    for (const b of buttons) b.disabled = false;
  };
  const [approve, except, reject] = buttons;
  if (approve) approve.onclick = act('approve');
  if (except) except.onclick = act('approve_except');
  if (reject) reject.onclick = act('reject');
  return card;
}

async function refreshGates() {
  const gates = await getJson<Gate[]>(`/api/gates?status=pending&deal=${encodeURIComponent(state.deal)}`);
  $('badge').textContent = String(gates.length);
  $('badge').classList.toggle('hot', gates.length > 0);
  const ids = gates.map((g) => g.id).join(',');
  if (ids === state.pendingIds) return; // never re-render under the reviewer's cursor
  if (state.pendingIds !== null && gates.length > state.pendingIds.split(',').filter(Boolean).length) beep();
  state.pendingIds = ids;
  const empty = document.createElement('div');
  empty.className = 'card empty muted';
  empty.textContent = 'No gates waiting. The agent will appear here when it asks for approval.';
  $('gates').replaceChildren(...(gates.length ? gates.map(gateCard) : [empty]));
}

// ---------- tables ----------

const TABLES = ['buy_vs_build', 'resource_load', 'validators', 'iteration_diff'] as const;
let tableTab: (typeof TABLES)[number] = 'validators';

async function renderTable() {
  $('table-tabs').replaceChildren(
    ...TABLES.map((t) => {
      const b = document.createElement('button');
      b.textContent = t.replaceAll('_', ' ');
      b.classList.toggle('on', t === tableTab);
      b.onclick = () => {
        tableTab = t;
        void renderTable();
      };
      return b;
    }),
  );
  const body = $('table-body');
  let t: Table;
  try {
    t = await getJson<Table>(`/api/tables/${tableTab}?deal=${encodeURIComponent(state.deal)}&iteration=${state.iteration}`);
  } catch (e) {
    t = { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (t.status === 'unavailable') {
    const p = document.createElement('p');
    p.className = 'muted empty';
    p.textContent = `Unavailable: ${t.reason}`;
    body.replaceChildren(p);
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const c of t.columns) head.append(Object.assign(document.createElement('th'), { textContent: c }));
  const tb = table.createTBody();
  for (const row of t.rows) {
    const tr = tb.insertRow();
    for (const v of row) tr.insertCell().textContent = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  }
  body.replaceChildren(table);
}

function toggleTables(show = $('tables').hidden) {
  $('tables').hidden = !show;
  if (show) void renderTable();
}

// ---------- polling ----------

async function poll() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    await refreshIterations();
    await Promise.all([refreshGraph(), refreshGates()]);
  } catch (e) {
    status(`Cannot reach the gate server (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    state.inFlight = false;
  }
}

// ---------- controls ----------

$<HTMLInputElement>('deal').value = state.deal;
$<HTMLInputElement>('deal').addEventListener('change', (e) => {
  state.deal = (e.target as HTMLInputElement).value.trim();
  state.iteration = 0;
  state.pendingIds = null;
  switchTo({});
});
$<HTMLSelectElement>('iteration').addEventListener('change', (e) => {
  state.follow = false;
  $<HTMLInputElement>('follow').checked = false;
  switchTo({ iteration: Number((e.target as HTMLSelectElement).value) });
});
$<HTMLInputElement>('follow').checked = state.follow;
$<HTMLInputElement>('follow').addEventListener('change', (e) => {
  state.follow = (e.target as HTMLInputElement).checked;
  void poll();
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-scene]')) b.onclick = () => switchTo({ scene: Number(b.dataset.scene) as Scene });
$('tables-btn').onclick = () => toggleTables();
$('tables').addEventListener('click', (e) => e.target === $('tables') && toggleTables(false));

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '1' || e.key === '2' || e.key === '3') switchTo({ scene: Number(e.key) as Scene });
  else if (e.key === '4') toggleTables();
  else if (e.key === 'Escape') toggleTables(false);
  else if (e.key === 'g') $('gate-panel').focus();
  else if (e.key === 'r') cy.fit(undefined, 40);
  else if (e.key === 'f') void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  else if (e.key === 'i') {
    state.follow = !state.follow;
    $<HTMLInputElement>('follow').checked = state.follow;
    void poll();
  }
});

switchTo({});
window.setInterval(() => void poll(), POLL_MS);
