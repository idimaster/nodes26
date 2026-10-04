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
| | `Task` | `id` (format `<pattern_id>.<task>`) | `summary`, `weeks_o`, `weeks_e`, `weeks_p`, `skill` ∈ {identity, platform, data, security, frontend, ops} |
| | `CapabilityType` | `id` | `name` |
| | `BuildOption` | `id` | `weeks_o`, `weeks_e`, `weeks_p`, `confidence`, `source` |
| | `PlatformCapability` | `id` | `name` |
| Evidence (per deal) | `Deal` | `code` | `target_company`, `acquirer`, `strategy` ∈ {pending, bridge, transform}, `status` ∈ {active, completed} |
| | `Finding` | `(deal_code, id)` | `kind` ∈ {capability, gap, risk, assumption, service}, `text`, `severity` ∈ {critical, high, medium, low}, `confidence`, `evidence_type` ∈ {code_inspection, vendor_docs, rfi, interview, assumption} |
| | `Source` | `(deal_code, id)` | `type`, `uri` |
| Plan (per deal) | `Iteration` | `(deal_code, n)` | `started_at`, `status` |
| | `FramedUseCase` | `(deal_code, iteration, id)` | `framing_rationale`, `use_case_id` |
| | `Candidate` | `(deal_code, iteration, uc, pattern)` | `fit_score`, `band`, `signal_snapshot` (JSON string) |
| | `Selection` | `(deal_code, iteration, uc)` | `pattern`, `fit_score`, `rationale`, `status` ∈ {draft, committed} |
| | `PlanTask` | `(deal_code, iteration, id)` | `task_id`, `weeks_o/e/p`, `skill` ∈ {identity, platform, data, security, frontend, ops}, `on_critical_path`, `earliest_start`, `wave` |
| | `Roadmap` | `(deal_code, version)` | `iteration`, `status` ∈ {draft, committed}, `gate_id` |
| | `CapabilityDecision` | `(deal_code, iteration, capability_id)` | `outcome` ∈ {integrate, build, retire, review}, `integrate_effort`, `build_effort`, `coverage`, `rule_version` |
| Decisions (per deal, **reserved**) | `GateDecision` | `id` | `deal_code`, `iteration`, `gate`, `status` ∈ {pending, approved, rejected}, `comment`, `by`, `at` |
| | `Feedback` | `id` | `deal_code`, `text`, `status` ∈ {open, resolved} |
| | `Override` | `id` | `deal_code`, `kind` ∈ {exclude_pattern, pin_pattern, include_use_case, exclude_use_case, strategy_for, directive}, `subject`, `value`, `active` |
| | `Actual` | `(deal_code, plan_task_id)` | `task_id` (catalog `Task.id`, denormalized), `weeks_actual`, `completed_at` |
| Meta (**reserved**) | `OntologyTerm` | `(kind, name)` | `kind` ∈ {label, relationship}, `scope` ∈ {global, `<deal_code>`}, `status` ∈ {proposed, active, rejected}, `definition`, `example`, `version` |

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
- `uc` (on Candidate, Selection, and in PlanTask ids) is always a catalog `UseCase` id. A FramedUseCase's `id` equals its `use_case_id`: one framing per use case per iteration, framed from one or more findings.
- `Iteration`, `FramedUseCase`, `Selection`, `PlanTask`, and `Roadmap` carry `status` ∈ {draft, committed} (Candidates and CapabilityDecisions are scored outputs, without status); `Finding.classified_as` stores the `classify_finding` result next to the original `kind`.
- `PlanTask.id` is `<uc>:<Task.id>` (the use case of its Selection, then the catalog task), so it is unique within an iteration even when a pattern is selected for two use cases.
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

All statements use `IF NOT EXISTS`, so applying the file is idempotent.

**Property types** live only in `config/ontology.json` (`types`: one of `string`, `integer`, `float`, `boolean`, `datetime` (ISO-8601 string in data files), `json` (a string holding JSON)), for every key and required property. Labels may carry extra, optional properties (e.g. `Pattern.not_recommended_when`); those are typed by the data-file schemas, not by the ontology.

---

## 2. MCP servers and tool contracts

| Server | Transport | Tools | Writes to Neo4j? |
|---|---|---|---|
| `neo4j-read` | official Neo4j MCP `v1.6.0`, `--read-only true` | `get-schema`, `read-cypher` | No |
| `neo4j-write` | official Neo4j MCP `v1.6.0`, `--read-only false` | `write-cypher` (**guarded**, §3) | Yes, via the agent |
| `planner-engine` | stdio (this repo, `npm run mcp:engine`) | see below. Tool errors (including a cycle, with its `witness`) come back as `isError` results | **Never** |
| `ontology` | stdio (this repo) | `get_ontology`, `propose_term` | Proposed terms only (own driver) |
| `gate` | stdio (this repo) | `request_approval`, `await_approval`, `resolve_feedback` | Decisions, feedback, overrides, term activation (own driver) |

**`planner-engine`** (pure functions; JSON in, JSON out):

| Tool | Input | Output |
|---|---|---|
| `recommend_strategy` | `deal_context` | Ranked strategies with `fit_score` and rationale (§2.1) |
| `classify_finding` | `findings[]`, each with its evidence (a batch, so step 2 is one call) | `gap` \| `assumption` \| `capability` \| `risk` \| `service` (§2.1) |
| `analyze_pattern_fit` | `use_case`, `deal_context`, `candidates[]` (retrieved by Cypher) | Ranked `FitAnalysis[]`: score, band, signal breakdown, reuse penalty, anti-applicability flags (§2.2) |
| `instantiate_tasks` | `deal`, `iteration`, `selections[]` | `plan_tasks[]` + `depends_on[]` (§2.3) |
| `compute_schedule` | `plan_tasks[]`, `depends_on[]` | Critical path, `earliest_start`, waves, PERT band (§2.3). Kahn longest path; **errors with a cycle witness on cyclic input**: the cycle's ids in `DEPENDS_ON` order, starting from its smallest id, with that id repeated at the end |
| `estimate_provenance` | task, baseline, observations[], modifiers[] | `{baseline, history_avg, n, modifiers, result, band}` (§2.4) |
| `classify_buy_build` | rows from BB1, thresholds | Outcome per capability, plus `rule_version` (§2.6) |
| `cypher_template` | template name | `{query, params_schema, destructive}` for the standard writes in §2.5 |

**Neo4j MCP details** (checked against the pinned binary):
- `config/neo4j-mcp.json` pins the release and the SHA-256 of each platform archive. `npm run mcp:neo4j:install` installs it into `.tools/` and refuses any other archive.
- `.mcp.json` (project level) launches both instances through `scripts/neo4j-mcp.sh`. The script maps `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` to the server's `NEO4J_MCP_*` variables and turns telemetry off (the upstream default is on).
- In read-only mode the server does not list `write-cypher` at all. `read-cypher` rejects writes by checking the query type with `EXPLAIN`.
- `write-cypher` takes `{query, params}`.
- Both instances also serve `list-gds-procedures`. The agent is not granted it (and is not granted `neo4j-write`'s read tools); scheduling calls GDS from our own code (§5.2).

Every number below lives in `config/thresholds.json`, not in code:

```json
{
  "classify":   { "strong_evidence": ["code_inspection", "vendor_docs", "rfi"], "min_confidence": 0.7 },
  "strategy":   { "base": 50, "per_signal": 10, "absorb_coverage": 0.8, "tie_break": "bridge" },
  "fit": {
    "weights":  { "use_case_match": 35, "text_overlap": 20, "strategy_compat": 20, "prereq_satisfaction": 15, "constraint_compat": 10 },
    "reuse":    { "free_picks": 2, "penalty_per_pick": 5 },
    "bands":    { "recommend": 60, "surface": 40, "review": 25 },
    "stopwords": ["the", "and", "..."]
  },
  "provenance": { "min_observations": 3 },
  "buy_build":  { "rule_version": "bb1-v1", "retire_coverage": 0.8, "integrate_ratio": 0.5, "build_ratio": 0.5 },
  "edge_coverage_floor": 0.6
}
```

### 2.1 Strategy and finding classification
- **`classify_finding`**: a finding is *strong* when `evidence_type` ∈ `classify.strong_evidence` and `confidence` ≥ `classify.min_confidence`.
  - `gap` or `assumption` → `gap` if strong, else `assumption`.
  - `capability` → `capability` if strong, else `assumption` (an unproven capability is an assumption).
  - `risk` and `service` pass through unchanged.
- **`recommend_strategy`**: `deal_context` holds the classified findings, each capability finding's `capability_type`, and the acquirer's `coverage` per capability type. Both strategies start at `strategy.base`; then, `per_signal` points each:
  - **transform** + for every capability finding whose type the acquirer covers at ≥ `absorb_coverage` (the platform can absorb it);
  - **bridge** + for every capability finding below that coverage (the target's capability is distinctive);
  - **bridge** + for every `risk` finding with severity `high` or `critical` (moving everything is riskier).
  - `fit_score` = the strategy's points ÷ the sum of both × 100, rounded to 1 decimal. Ties go to `tie_break`. The rationale lists the finding ids behind each point.

### 2.2 Pattern fit (Option B)
For one framed use case, each candidate pattern scores the sum of five signals (maximum 100), minus the reuse penalty, clamped to [0, 100], rounded to 1 decimal:

| Signal | Points |
|---|---|
| `use_case_match` | full weight if the pattern `SOLVES` the framed use case's `UseCase`, else 0 |
| `text_overlap` | weight × \|C ∩ P\| ÷ \|P\|, where P = tokens of the pattern's name and description and C = tokens of the use case's description plus the text of every finding it is `FRAMED_FROM`. Tokens: lowercase `[a-z0-9]+` runs of length ≥ 3, minus `fit.stopwords` and the tokens of the deal's `target_company` and `acquirer` |
| `strategy_compat` | full weight if the pattern `APPLIES_TO` the deal's strategy, else 0 |
| `prereq_satisfaction` | weight × (required patterns already selected in this iteration ÷ required patterns); full weight when the pattern has no `REQUIRES` |
| `constraint_compat` | weight × (1 − flagged ÷ total) over the pattern's `not_recommended_when` rules; full weight when it has none. `deal_context.flagged_rules[pattern]` lists the rules that apply (the LLM proposes them; the engine only counts) |

- **Reuse penalty:** for the *n*-th Selection of the same pattern in one iteration (counting this one), the penalty is `penalty_per_pick` × max(0, *n* − `free_picks`). So the 3rd use costs 5 and the 4th costs 10.
- **Conflicts are not scored.** Two use cases may each rank a conflicting pattern first; V2 catches that (P2).
- **Bands** on the rounded score: [`recommend`, 100] recommend, [`surface`, `recommend`) surface, [`review`, `surface`) review, below `review` hidden.
- **Ranking:** score descending, then pattern id ascending.

### 2.3 Tasks and schedule
- **`instantiate_tasks`**: one PlanTask per catalog Task of each selected pattern (id per §1.3), copying `weeks_o/e/p` and `skill`. `depends_on` contains:
  - the catalog `DEPENDS_ON` edges, within the same Selection;
  - for every `REQUIRES` from the Selection's pattern to a pattern selected in the same iteration: an edge from each of the Selection's root tasks (no prerequisites) to each final task (no dependents) of every such Selection.
- **`compute_schedule`**: durations are `weeks_e`. `weeks_o`, `weeks_e`, `weeks_p` are the optimistic, **most likely**, and pessimistic estimates. Output per task: `earliest_start`, `wave`, `on_critical_path` (definitions in §5.2), plus the plan's finish and one critical path (ties broken by PlanTask id). The PERT band sums over that critical path: mean = Σ (o + 4e + p) ÷ 6, σ = √Σ ((p − o) ÷ 6)², reported as `{mean, sigma, p10: mean − 1.2816σ, p90: mean + 1.2816σ}`.

### 2.4 Estimate provenance
`baseline` is the Task's `weeks_e`. `history_avg` is the mean `Actual.weeks_actual` over the `n` observations of that Task (§5.3).
- `n` ≥ `provenance.min_observations`: blended = `history_avg`.
- 0 < `n` < `min_observations`: blended = (`baseline` + `n` × `history_avg`) ÷ (1 + `n`).
- `n` = 0: blended = `baseline`.

`result` = blended × the product of every modifier's `factor`, rounded to 1 decimal. `band` = [`weeks_o`, `weeks_p`] × `result` ÷ `baseline`, each rounded to 1 decimal.

### 2.5 Cypher templates
`packages/engine/src/templates.ts` holds the agent's standard writes. Each follows the CLAUDE.md Cypher style and wraps integer parameters in `toInteger()`, because MCP hosts pass JSON numbers that would otherwise be stored as floats.

| Template | Writes |
|---|---|
| `set_deal_strategy` | `Deal.strategy` after the frame gate |
| `create_iteration` | `Iteration` (draft) + `HAS_ITERATION` |
| `classify_findings` | `Finding.classified_as` |
| `write_framed_use_cases` | `FramedUseCase` + `IN_ITERATION`, `INSTANCE_OF`, `FRAMED_FROM` |
| `write_candidates` | `Candidate` + `IN_ITERATION`, `FOR`, `OF` |
| `write_selections` | `Selection` (draft) + `IN_ITERATION`, `FOR`, `SELECTS`; other candidates `ALTERNATIVE_TO` it |
| `replace_selection` | **destructive.** Repairs a *draft* Selection: deletes its `SELECTS`, its PlanTasks, and its `ALTERNATIVE_TO` edges, then re-points it. The agent then re-runs `instantiate_tasks` + `write_plan_tasks` |
| `write_plan_tasks` | `PlanTask` + `IN_ITERATION`, `HAS_TASK`, `INSTANTIATES`, `DEPENDS_ON` |
| `write_schedule` | `earliest_start`, `wave`, `on_critical_path` |
| `commit_roadmap` | `Roadmap` (committed) + `INCLUDES`; promotes the iteration's plan nodes (needs G8) |
| `write_capability_decisions` | `CapabilityDecision` + `HAS_DECISION` (allowed after commit: buy vs build is step 11) |

**Safety contract**, tested against Neo4j:
- Plan writes (`write_framed_use_cases` to `write_schedule`, and `replace_selection`) only touch a **draft** iteration. On a committed one they write nothing.
- `status` is set to `draft` only `ON CREATE`, so re-running a template never demotes a committed node. Only `commit_roadmap` writes `committed`.
- `write_selections` never re-points an existing Selection: a different pattern for the same use case is returned in `rejected`. Re-pointing is `replace_selection`'s job. It refuses (returns no rows) when any of the Selection's PlanTasks has an `ON`, `RESOLVED_BY`, `DECIDED_ON`, or `OBSERVED_FOR` edge, so a repair never deletes what a gate, feedback, or actual refers to.
- `commit_roadmap` refuses (no rows) to reuse a roadmap version that belongs to another iteration.
- Templates do not throw on refused rows: they return counts, or no rows. **The skill compares every count with its input and stops on a mismatch** (an unknown use case, finding, pattern, or task id is never written).

### 2.6 Buy vs build
Each BB1 row has `capability_id`, `integrate_effort` (sum of `weeks_e` of the PlanTasks of the Selection whose framed use case is `FRAMED_FROM` the capability finding), `build_effort` (`BuildOption.weeks_e` for that `CapabilityType`), and `coverage` (the acquirer's `PROVIDES` coverage, 0 if none). Rules, first match wins (`rule_version` `bb1-v1`):
1. `coverage` ≥ `retire_coverage` → **retire** (the acquirer's platform replaces it);
2. `integrate_effort` ≤ `integrate_ratio` × `build_effort` → **integrate**;
3. `build_effort` ≤ `build_ratio` × `integrate_effort` → **build**;
4. otherwise → **review**.

A capability finding with no Selection has no `integrate_effort`. It is reported as `unplanned`, and no CapabilityDecision is written for it.

---

## 3. Write guard (`packages/guard`)

`validate(query, params, ctx) → {allow: true} | {allow: false, reason}`. It is used by the Claude Code `PreToolUse` hook adapter and by any other host's tool wrapper. The deny reason is written so that the agent can fix its query from it.

The guard first **tokenizes** the query: string literals (single- and double-quoted, with escapes), `//` and `/* */` comments, backtick-quoted identifiers (compared without the backticks), parameters, and keywords. Every rule below works on tokens, so a keyword inside a string or comment never triggers it, and one inside backticks never escapes it.

| Rule | Deny when |
|---|---|
| G1 | More than one statement (a `;` token anywhere except at the very end) |
| G2 | `DELETE`, `DETACH`, `REMOVE`, `DROP`, `LOAD CSV`, `FOREACH`, `IN TRANSACTIONS`, any `dbms.` name, and schema or admin commands (`CREATE INDEX`/`CONSTRAINT`/`DATABASE`/`ALIAS`/`USER`/`ROLE`, `ALTER`, `GRANT`, `DENY`, `REVOKE`, `USE`, `START`, `STOP`, `TERMINATE`). **One exception:** a query whose text is exactly a `cypher_template` marked `destructive` (today only `replace_selection`), with params that pass that template's schema; every other rule still applies to it |
| G3 | A procedure `CALL` not on the allowlist (`db.labels`, `db.relationshipTypes`), or any `apoc.*` or `gds.*` function (e.g. `gds.util.asNode` fetches nodes the guard cannot see). A `CALL {…}` or `CALL (vars) {…}` subquery is not a procedure call; its body is checked like the rest. Use the built-in `randomUUID()` for ids |
| G4 | Unbounded variable-length pattern (`*`, `*..`, `*n..`), or an upper bound above 10. The same for quantified path patterns: `+` or `*` after a pattern, `{m,}`, or `{m,n}` with n > 10 |
| G5 | The query writes (`CREATE`, `MERGE`, `SET`) a per-deal label, but `params.deal` is missing or the query text never references `$deal` |
| G6 | Any label or relationship type (after `:` or `IS`) is not in the core ontology or in active terms for `global` or `params.deal`. **Dynamic labels or types** (`$(…)`, `$any(…)`, `$all(…)`), label wildcards (`%`), and negation (`!`) are always denied, because they cannot be checked lexically |
| G7 | Query touches a **reserved** label (§1.1), in any clause, or (in a write query) could reach one without naming it. See *Writes* below |
| G8 | The query could make anything `committed`: the token `committed` appears in a string literal (after decoding escapes), **or any parameter value (searched recursively through maps and lists) contains `committed`**. Allowed only if `params.gate_id` resolves to a GateDecision with `deal_code = params.deal`, `iteration = params.iteration`, `gate = 'commit'`, and `status = 'approved'` (one read query). `params.iteration` is required. A `status` property may only be written as a plain string literal, so the value cannot be assembled (`'commit' + 'ted'`) |
| G9 | No `RETURN` clause |

**Writes** (any of `CREATE`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`). The guard checks what it positively understands instead of listing what is forbidden. An adversarial review found nine ways around a denylist (`IS` labels, `:%`, variable reuse after `WITH`, backticked namespaces, clause words inside expressions, dynamic property writes, …); this design closes each class:
- **Variable scopes are tracked.** A node is *labeled* when a pattern binds it with a label in the current scope.
  - `WITH` keeps only bare variables and `x AS y` aliases (or everything for `WITH *`).
  - `UNWIND` and `YIELD` variables are unlabeled.
  - `CALL (a, b) {…}` sees only `a` and `b`; `CALL {…}` sees nothing.
  - `EXISTS`/`COUNT`/`COLLECT` blocks and list or pattern comprehensions see the outer scope.
  - `UNION` starts empty.
- **Node patterns** bind only in `MATCH`, `OPTIONAL MATCH`, `MERGE`, and `CREATE`. There they must carry a label or use a labeled variable; `(v WHERE …)` counts as unlabeled. In `WHERE` and other expressions, `(v:Label)` is a label *test* and binds nothing (`NOT (g:Strategy)` must not make `g` look labeled). Anonymous nodes are allowed only outside `CREATE`/`MERGE`.
- **Unsupported syntax is denied (G2):** Cypher 25/GQL clauses (`NEXT`, `LET`, `FILTER`, `INSERT`, `WHEN`/`THEN`/`ELSE` outside `CASE`), path selectors and match modes (`ANY`/`ALL` selectors, `SHORTEST`, `REPEATABLE`, `DIFFERENT`, `WALK`, `TRAIL`, `ACYCLIC`), `SHOW`, `CYPHER`, `EXPLAIN`, and `PROFILE`. Variables may not be named like keywords.
- **SET items** must be `var.prop = value` or `var:Label`/`var IS Label`. `var` must be a labeled node or a relationship variable with exactly one explicit, non-reserved type. Everything else is denied: `SET n[...]`, `SET (expr).x`, `SET n = …`, `SET n += …`.
- `nodes()`, `relationships()`, `startNode()`, and `endNode()` are denied, as is any relationship type with a reserved endpoint in `CREATE`/`MERGE`.
- Clause context is tracked per bracket, so a `WHERE` inside `[x IN … WHERE …]` or a label named like a clause does not change the enclosing clause.

**Limits.** The guard is lexical; it does not parse Cypher, and it is defense in depth, not proof. It was hardened over three adversarial review rounds (9, then 7, then 1 confirmed bypass class, each closed and kept as a regression test in `packages/guard/test/validate.test.ts`). The deeper guarantees are structural: the agent's standard writes are fixed templates (§2.5), and reserved data is written only through the gate and ontology servers' own drivers.

When unsure, the guard denies. Every decision, allow or deny, is logged with its reason. The deny reason names the rule and the offending token, so the agent can fix the query.

**Adapter** (`packages/guard/bin/guard-hook.ts`): a Claude Code `PreToolUse` hook for any `…__write-cypher` tool. Before validating, it reads the active ontology terms (global and `params.deal`) in one read query; G8 adds one gate lookup.
- It prints a `deny` decision with the reason, or nothing on allow. It never auto-approves, so the user's permission settings still apply.
- It **fails closed**: unreadable input or an unreachable graph is a deny.
- It logs one JSON line per decision to `.logs/guard.jsonl`.
- It is registered in `hooks/hooks.json` (plugin) and, until the plugin exists (T2.6), in the project `.claude/settings.json`.

---

## 4. Gates (`packages/gate` + console)

- **`request_approval({deal, iteration, gate, subject_ids[], summary})`**
  1. The server writes `GateDecision {status:'pending'}` with `DECIDED_ON` edges to each subject.
  2. It shows the card in the console.
  3. It blocks for up to 50 seconds, returning the decision if one arrives in time, else `{status:'pending', gate_id}`.
  - `gate` ∈ {`frame`, `select`, `commit`, `ontology_term`, `ontology_promote`}.
- **`await_approval({gate_id})`**: the same long-poll. The skill keeps calling it until the gate resolves.
- **`resolve_feedback({deal, feedback_id, resolved_by_ids[]})`**: the agent calls this when a change in a later iteration addresses open Feedback. The server writes `RESOLVED_BY` from the Feedback to each given plan node of that deal and sets `status: 'resolved'`. It refuses unknown ids, ids from another deal, and Feedback that is already resolved. This is the only way Feedback changes after it is created, because the agent cannot write the reserved `Feedback` label (G7).
- **Console** (`viz/` panel): shows the summary, scores, alternatives, and a provenance link. Actions are **Approve**, **Approve except…**, and **Reject**, each with an optional comment.
- **Server-side writes on decision** (own driver, never via the agent):
  - Status, `by`, `at`, and `comment` on the GateDecision.
  - If there is a comment, `Feedback {status:'open'}` with `ON` → each subject and `FROM` → the GateDecision.
  - Overrides from the comment, one per line or sentence that matches the grammar below, with `CREATED` from the GateDecision and `CONSTRAINS` to the subject. `X` must be an existing pattern or use-case id; anything else is only Feedback.

    | Phrase | Override |
    |---|---|
    | *remove X*, *except X* (pattern) | `kind: exclude_pattern`, `subject: X` |
    | *remove X*, *except X* (use case) | `kind: exclude_use_case`, `subject: X` |
    | *keep X* (pattern) | `kind: pin_pattern`, `subject: X` |
    | *include X* (use case) | `kind: include_use_case`, `subject: X` |
    | *use bridge for X*, *use transform for X* | `kind: strategy_for`, `subject: X`, `value: bridge`/`transform` |
    | *directive: text* | `kind: directive`, `subject: ''`, `value: text` (no `CONSTRAINS`) |

    Every Override has `active: true` and `value: ''` unless the table says otherwise. **Approve except…** approves the gate and writes the overrides for the excepted subjects.
  - For the `ontology_term` gate: the term becomes `active`, plus a uniqueness constraint `(deal_code, id)` for new labels.
- **Return value:** `{status, gate_id, feedback_ids[], overrides[]}`.
- `request_approval` and `await_approval` return before the host's MCP tool timeout. `MCP_TOOL_TIMEOUT` is set above 50 seconds in the plugin env.

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
2. Project with GDS from **prerequisite → dependent**, weighted by the prerequisite's `weeks_e`. Run `gds.dag.longestPath.stream` (present in the pinned GDS 2026.08.1). Verify the procedure exists in the installed GDS version at startup; otherwise fall back to `compute_schedule` (Kahn). A parity test asserts both produce identical results on fixtures.
3. Write back `on_critical_path`, `earliest_start`, and `wave`, defined over the PlanTask DAG (durations are `weeks_e`):
   - `earliest_start` = 0 for a task with no prerequisites, else max over prerequisites of (`earliest_start` + `weeks_e`);
   - `wave` = 1 for a task with no prerequisites, else 1 + max over prerequisites of `wave`;
   - `on_critical_path` = true when the task has zero slack: its latest start (computed backward from the plan's finish, max of `earliest_start` + `weeks_e`) equals its `earliest_start` (compared with a 1e-9 tolerance).
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
12. **On feedback.** Start `Iteration n+1`, call `recall_memory`, replan, call `resolve_feedback` for each Feedback the new plan addresses, then call `iteration_diff`.

Loop safety: `maxTurns`/`stopWhen` must be set by the host, and the repair loop is bounded at 2.
