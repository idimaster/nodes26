# Design contract: Neurosymbolic Integration Planner on Neo4j MCP

This file is the **implementation contract**. Code, tests, and the agent skill must agree with it. If you need to change it, change this file first, in the same PR.

Principle: **the LLM proposes; the graph decides.** The LLM is used only for:
- framing findings into use cases,
- choosing among candidates that have already been scored,
- repairing a plan against a witness,
- writing the narrative.

Everything else is deterministic code or Cypher.

---

## 1. Ontology

### 1.1 Labels and keys

| Subgraph | Label | Key (unique constraint) | Required properties |
|---|---|---|---|
| Knowledge (global) | `Strategy` | `id` | `description` |
| | `Track` | `id` | `name`, `order` |
| | `UseCase` | `id` | `display`, `description` |
| | `Pattern` | `id` | `name`, `description`, `reference` (public source) |
| | `Task` | `id` (format `<pattern_id>.<task>`) | `summary`, `weeks_o`, `weeks_e`, `weeks_p`, `skill` |
| | `CapabilityType` | `id` | `name` |
| | `BuildOption` | `id` | `weeks_o`, `weeks_e`, `weeks_p`, `confidence`, `source` |
| | `PlatformCapability` | `id` | `name` |
| Evidence (per deal) | `Deal` | `code` | `target_company`, `acquirer`, `strategy`, `status` |
| | `Finding` | `(deal_code, id)` | `kind` ∈ {capability, gap, risk, assumption, service}, `text`, `severity`, `confidence`, `evidence_type` |
| | `Source` | `(deal_code, id)` | `type`, `uri` |
| Plan (per deal) | `Iteration` | `(deal_code, n)` | `started_at`, `status` |
| | `FramedUseCase` | `(deal_code, iteration, id)` | `framing_rationale`, `use_case_id` |
| | `Candidate` | `(deal_code, iteration, uc, pattern)` | `fit_score`, `band`, `signal_snapshot` (JSON string) |
| | `Selection` | `(deal_code, iteration, uc)` | `pattern`, `fit_score`, `rationale`, `status` ∈ {draft, committed} |
| | `PlanTask` | `(deal_code, iteration, id)` | `task_id`, `weeks_o/e/p`, `skill`, `on_critical_path`, `earliest_start`, `wave` |
| | `Roadmap` | `(deal_code, version)` | `iteration`, `status` ∈ {draft, committed}, `gate_id` |
| | `CapabilityDecision` | `(deal_code, iteration, capability_id)` | `outcome`, `integrate_effort`, `build_effort`, `coverage`, `rule_version` |
| Decisions (per deal, **reserved**) | `GateDecision` | `id` | `deal_code`, `iteration`, `gate`, `status` ∈ {pending, approved, rejected}, `comment`, `by`, `at` |
| | `Feedback` | `id` | `deal_code`, `text`, `status` ∈ {open, resolved} |
| | `Override` | `id` | `deal_code`, `kind` ∈ {exclude_pattern, pin_pattern, include_use_case, exclude_use_case, strategy_for, directive}, `subject`, `active` |
| | `Actual` | `(deal_code, plan_task_id)` | `task_id` (catalog `Task.id`, denormalized), `weeks_actual`, `completed_at` |
| Meta (**reserved**) | `OntologyTerm` | `(kind, name)` | `scope` ∈ {global, `<deal_code>`}, `status` ∈ {proposed, active, rejected}, `definition`, `example`, `version` |

**Reserved labels** may be written **only** by the gate server, the ontology server, and the loaders. Agent-written Cypher can never create or modify them (guard rule G7).

**Keys and edition.** Every key above becomes one uniqueness constraint (single or composite property); that is 23 constraints. The demo targets **Neo4j Community**, where property-existence constraints are unavailable, so "required properties" are enforced by zod schemas in the loaders and servers, not by the database.

**Observed durations.** Historical actuals are modeled only as `Actual` nodes on the committed plans of past deals (`Actual -[:OBSERVED_FOR]-> PlanTask -[:INSTANTIATES]-> Task`). There is no separate observation label.

### 1.2 Relationships

- **Knowledge:**
  - `(Pattern)-[:SOLVES]->(UseCase)`
  - `(Pattern)-[:APPLIES_TO]->(Strategy)`
  - `(Pattern)-[:IN_TRACK]->(Track)`
  - `(Pattern)-[:HAS_TASK]->(Task)`
  - `(Task)-[:DEPENDS_ON]->(Task)`
  - `(Pattern)-[:REQUIRES|CONFLICTS|AUGMENTS|SUPERSEDES]->(Pattern)`
  - `(BuildOption)-[:DELIVERS]->(CapabilityType)`
  - `(PlatformCapability)-[:PROVIDES {coverage}]->(CapabilityType)`
- **Evidence:**
  - `(Deal)-[:HAS_FINDING]->(Finding)`
  - `(Finding)-[:SUPPORTED_BY]->(Source)`
  - `(Finding)-[:CALLS]->(Finding)` (services)
  - `(Finding)-[:IS_A]->(CapabilityType)`
- **Plan:**
  - `(Deal)-[:HAS_ITERATION]->(Iteration)`
  - `(FramedUseCase|Selection|PlanTask|Candidate)-[:IN_ITERATION]->(Iteration)`
  - `(FramedUseCase)-[:FRAMED_FROM]->(Finding)`
  - `(FramedUseCase)-[:INSTANCE_OF]->(UseCase)`
  - `(Candidate)-[:FOR]->(FramedUseCase)` and `(Candidate)-[:OF]->(Pattern)`
  - `(Candidate)-[:ALTERNATIVE_TO]->(Selection)`
  - `(Selection)-[:FOR]->(FramedUseCase)` and `(Selection)-[:SELECTS]->(Pattern)`
  - `(Selection)-[:HAS_TASK]->(PlanTask)`
  - `(PlanTask)-[:INSTANTIATES]->(Task)`
  - `(PlanTask)-[:DEPENDS_ON]->(PlanTask)`
  - `(Roadmap)-[:INCLUDES]->(Selection)`
  - `(Deal)-[:HAS_DECISION]->(CapabilityDecision)`
- **Decisions:**
  - `(GateDecision)-[:DECIDED_ON]->(any plan node | OntologyTerm)` (an `ontology_term` or `ontology_promote` gate decides on the term)
  - `(Feedback)-[:ON]->(any plan node)`
  - `(Feedback)-[:FROM]->(GateDecision)`
  - `(Feedback)-[:RESOLVED_BY]->(any plan node)`
  - `(Override)-[:CONSTRAINS]->(UseCase|Pattern|Strategy)`
  - `(GateDecision)-[:CREATED]->(Override)`
  - `(Actual)-[:OBSERVED_FOR]->(PlanTask)`
- **Meta:**
  - `(OntologyTerm)-[:MOTIVATED_BY]->(Finding)`
  - `(OntologyTerm)-[:APPROVED_BY]->(GateDecision)`

"Any plan node" means any label in the Plan subgraph of §1.1: `Iteration`, `FramedUseCase`, `Candidate`, `Selection`, `PlanTask`, `Roadmap`, `CapabilityDecision`.

**Direction convention:** `DEPENDS_ON` points from the dependent to its prerequisite. Scheduling projections flip it (§5.2).

### 1.3 Conventions
- Every per-deal node carries `deal_code`. Every per-deal query takes `$deal`.
- A draft plan is the set of nodes in the current `Iteration` with `status: 'draft'`. Promotion to `committed` requires an approved gate (§3, §4).
- Deal-scoped ontology terms (`scope = $deal`) are usable only in that deal. Promotion to `global` is a separate gate.

### 1.4 Machine-readable ontology
`config/ontology.json` is the single source for the core ontology: every label with its subgraph, key properties, required properties, and `reserved` flag; every relationship type with its allowed endpoint labels. It is consumed by:
- `graph/schema.cypher` (generated from it, or tested against it: one constraint per key, one `deal_code` index per per-deal label);
- the loaders' zod schemas (required properties);
- guard rules G5, G6, G7 (per-deal, allowed, and reserved tokens);
- `get_ontology` (core terms, merged with active `OntologyTerm`s).

A change to §1.1 or §1.2 must change `config/ontology.json` in the same commit; a test asserts they agree.

**Generated DDL.** `graph/schema.cypher` is generated from `config/ontology.json` (`npm run schema:gen`) and committed; a test asserts the file matches. It contains:
- one uniqueness constraint per label key, named `<label_snake>_key` (23);
- one range index on `deal_code`, named `<label_snake>_deal_code`, for every per-deal label that carries a `deal_code` property (13: every Evidence, Plan, and Decisions label except `Deal`, whose `code` constraint already indexes it).

All statements use `IF NOT EXISTS`, so applying the file is idempotent. Property types are not yet part of the ontology file; they are added with the data schemas (T1.3).

---

## 2. MCP servers and tool contracts

| Server | Transport | Tools | Writes to Neo4j? |
|---|---|---|---|
| `neo4j-read` | official Neo4j MCP, `NEO4J_READ_ONLY=true` | `get-schema`, `read-cypher` | No |
| `neo4j-write` | official Neo4j MCP | `write-cypher` (**guarded**, §3) | Yes, via the agent |
| `planner-engine` | stdio (this repo) | see below | **Never** |
| `ontology` | stdio (this repo) | `get_ontology`, `propose_term` | Proposed terms only (own driver) |
| `gate` | stdio (this repo) | `request_approval`, `await_approval` | Decisions, feedback, overrides, term activation (own driver) |

**`planner-engine`** (pure functions; JSON in, JSON out):

| Tool | Input | Output |
|---|---|---|
| `recommend_strategy` | `deal_context` | Ranked strategies with `fit_score` and rationale |
| `classify_finding` | finding with evidence | `gap` \| `assumption` \| `capability`. Gap needs strong evidence (code inspection, vendor docs, or RFI) at confidence ≥ 0.7 |
| `analyze_pattern_fit` | `use_case`, `deal_context`, `candidates[]` (retrieved by Cypher) | Ranked `FitAnalysis[]`: score, band, signal breakdown, reuse penalty, anti-applicability flags |
| `instantiate_tasks` | `deal`, `iteration`, `selections[]` | `plan_tasks[]` + `depends_on[]` (intra- and cross-pattern via `REQUIRES`) |
| `compute_schedule` | `plan_tasks[]`, `depends_on[]` | Critical path, `earliest_start`, waves, PERT band. Kahn longest path; **errors with a cycle witness on cyclic input** |
| `estimate_provenance` | task, baseline, observations[], modifiers[] | `{baseline, history_avg, n, modifiers, result, band}` |
| `classify_buy_build` | rows from BB1, thresholds | Outcome per capability, plus `rule_version` |
| `cypher_template` | template name | `{query, params_schema}` for standard writes |

Fit signals (Option B): `use_case_match` 35, `text_overlap` 20, `strategy_compat` 20, `prereq_satisfaction` 15, `constraint_compat` 10. The reuse penalty is −5 per reuse after 2 free picks. Bands: ≥ 60 recommend, 40–59 surface, 25–39 review, < 25 hidden. Thresholds live in `config/thresholds.json`.

---

## 3. Write guard (`packages/guard`)

`validate(query, params, ctx) → {allow: true} | {allow: false, reason}`. It is used by the Claude Code `PreToolUse` hook adapter and by any other host's tool wrapper. The deny reason is written so that the agent can fix its query from it.

| Rule | Deny when |
|---|---|
| G1 | More than one statement (`;` outside strings) |
| G2 | `DELETE`, `DETACH`, `REMOVE`, `DROP`, `LOAD CSV`, `apoc.periodic`, `dbms.` |
| G3 | `CALL` to a procedure not on the allowlist (`apoc.merge.node`, `apoc.create.uuid`, `db.labels`, `db.relationshipTypes`) |
| G4 | Unbounded variable-length pattern (`*`, `*..`, `*n..`), or an upper bound above 10 |
| G5 | Query writes a per-deal label but `params.deal` is missing |
| G6 | Any `:Label` or `[:REL]` token is not in the core ontology or in active terms for `global` or `params.deal` |
| G7 | Query touches a **reserved** label (§1.1) |
| G8 | Query sets `status = 'committed'` or creates `Roadmap` with `status 'committed'`, but `params.gate_id` does not resolve to an `approved` GateDecision for `params.deal` and the current iteration (one read query) |
| G9 | No `RETURN` clause |

Label extraction is lexical and conservative: when unsure, deny. Every decision, allow or deny, is logged with its reason.

---

## 4. Gates (`packages/gate` + console)

- **`request_approval({deal, iteration, gate, subject_ids[], summary})`**
  1. The server writes `GateDecision {status:'pending'}` with `DECIDED_ON` edges to each subject.
  2. It shows the card in the console.
  3. It blocks for up to 50 seconds, returning the decision if one arrives in time, else `{status:'pending', gate_id}`.
  - `gate` ∈ {`frame`, `select`, `commit`, `ontology_term`, `ontology_promote`}.
- **`await_approval({gate_id})`**: the same long-poll. The skill keeps calling it until the gate resolves.
- **Console** (`viz/` panel): shows the summary, scores, alternatives, and a provenance link. Actions are **Approve**, **Approve except…**, and **Reject**, each with an optional comment.
- **Server-side writes on decision** (own driver, never via the agent):
  - Status, `by`, `at`, and `comment` on the GateDecision.
  - If there is a comment, `Feedback {status:'open'}` with `ON` → each subject and `FROM` → the GateDecision.
  - For the grammar *remove X*, *keep X*, *use bridge for X*, *except X*: `Override` nodes plus `CREATED`.
  - For the `ontology_term` gate: the term becomes `active`, plus a uniqueness constraint `(deal_code, id)` for new labels.
- **Return value:** `{status, gate_id, feedback_ids[], overrides[]}`.

---

## 5. Validators and analytics (`graph/queries/`)

Every validator returns **one row**:

```
{check, examined, violations: [{witness, detail}], verdict}
```

Rules:
- Use `OPTIONAL MATCH` for the examined set, so an empty graph returns a row instead of nothing.
- `examined = 0` → verdict `FAIL: nothing checked`.
- A witness is a list of node ids (a path, pair, or single node).

### 5.1 Validators

| Id | Check | Layer | Verdict on violation |
|---|---|---|---|
| V1 | Prerequisite closure: `REQUIRES*1..5` from selected patterns to unselected patterns | Constraint | FAIL; the skill **derives** (adds) the missing prerequisite |
| V2 | Conflicting selections: `CONFLICTS` between two selected patterns | Constraint | FAIL; the LLM repairs (stored near-miss first) |
| V3 | Task cycle: `PlanTask-[:DEPENDS_ON*1..10]->` itself | Structural | FAIL |
| V4 | Uncovered critical gap: `Finding {kind:'gap', severity:'critical'}` with no `FRAMED_FROM` ← FramedUseCase ← Selection in this iteration. **Exact provenance only, no track fallback.** | Coverage | FAIL |
| V5 | Active `exclude_pattern` Override violated by a Selection | Coverage | FAIL |
| V6 | Audit chain: Selection without `fit_score`; FramedUseCase without `framing_rationale` | Audit | FAIL |
| V6b | No Candidate within 20 points of a Selection | Audit | WARN |
| V7 | Knowledge-edge coverage: share of patterns with any `REQUIRES`/`CONFLICTS`/`AUGMENTS` edge | Data | Report; CI fails below the configured floor (demo: 0.6) |

### 5.2 Scheduling
1. Run V3 first. If V3 finds a cycle, do **not** schedule; return the witness.
2. Project with GDS from **prerequisite → dependent**, weighted by the prerequisite's `weeks_e`. Run `gds.dag.longestPath`. Verify the procedure exists in the installed GDS version at startup; otherwise fall back to `compute_schedule` (Kahn). A parity test asserts both produce identical results on fixtures.
3. Write back `on_critical_path`, `earliest_start`, and `wave`.
4. Compute resource load as `sum(weeks_e)` grouped by `skill` and `wave`.

### 5.3 Other queries
- **Grounding:** candidate retrieval (UseCase ← SOLVES ← Pattern → APPLIES_TO → Strategy, minus active exclude Overrides); prior-project estimates (avg `Actual.weeks_actual` per Task, with count).
- **Memory:** `recall_memory` (latest iteration plus open Feedback with targets); `iteration_diff` (selections new in iteration *n* vs *n − 1*, each with its `RESOLVED_BY` feedback).
- **Buy vs build (BB1):** per capability finding, integrate effort from PlanTasks, build effort from BuildOption, and coverage from PlatformCapability → `classify_buy_build`.

---

## 6. Agent workflow (`skills/plan-integration/SKILL.md`)

1. **Ground.** Call `get_ontology`, then `get-schema`. Read the deal's findings and prior-project estimates.
2. **Ingest.** Run `classify_finding` on each finding, then write Finding and Source nodes.
3. **Strategy.** Run `recommend_strategy`, then `request_approval(gate: frame)` together with step 4.
4. **Frame.** The LLM drafts framings and writes FramedUseCase nodes as draft. If it needs a concept missing from the ontology, it calls `propose_term`, which triggers `request_approval(gate: ontology_term)`.
5. **Retrieve and score.** Use read-cypher for retrieval, then `analyze_pattern_fit`. Write the top 3 as Candidates.
6. **Select.** The LLM chooses among candidates and writes draft Selections. Then call `request_approval(gate: select)`.
7. **Instantiate.** Run `instantiate_tasks` and write PlanTasks and their dependencies.
8. **Validate.** Run V1–V6.
   - Derive V1 fixes automatically.
   - Repair V2 and others against the witness, at most 2 loops, then escalate.
9. **Schedule** (§5.2).
10. **Commit.** Call `request_approval(gate: commit)`, then promote with `$gate_id` (G8).
11. **Buy vs build.** Run BB1 and write CapabilityDecision nodes.
12. **On feedback.** Start `Iteration n+1`, call `recall_memory`, replan, then call `iteration_diff`.

Loop safety: `maxTurns`/`stopWhen` must be set by the host, and the repair loop is bounded at 2.
