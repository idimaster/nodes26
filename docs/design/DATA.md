# Demo data contract (all fictional)

## Universe
- **Harborline Software** (acquirer): B2B SaaS platform. Its platform capabilities (corporate IdP, API gateway, audit-log pipeline, event bus, billing platform) are modeled as `PlatformCapability` nodes with `coverage` per `CapabilityType`.
- **Nimbus Ledger** (target; `deal_code: nimbus`): accounting and AP-automation SaaS with about 25 findings across identity, security, API, data, infrastructure, and operations.
- **History:** two completed integrations, `tidewater` (analytics startup) and `quarry` (document-capture vendor). Each is loaded as a full committed plan (`Deal`, `Iteration`, `Selection`, `PlanTask`, committed `Roadmap`) plus `Actual` durations on about 50 PlanTasks in total.

**Naming rule:** no names of real companies, products, people, or deals in the scenario or data. Public standards (SAML 2.0, OIDC, SCIM) and the tooling this repo is built on are fine. CI runs `scripts/denylist-check.ts`, which reads denylisted terms from `$DENYLIST_FILE` (stored **outside** this repo; in CI it comes from a secret) and fails on any match.

## Catalog (`data/catalog/`)

| Asset | Count | Requirements |
|---|---|---|
| Patterns | ~25 | Task DAG with three-point estimates and a `skill` ∈ {identity, platform, data, security, frontend, ops}; `solves_use_cases`; `applicable_strategies` ⊆ {bridge, transform}; `reference` to a public standard or practice (e.g. SAML 2.0, OIDC, SCIM, strangler fig, CDC replication, API gateway facade); `not_recommended_when` rules on ≥ 5 patterns; `REQUIRES`/`CONFLICTS`/`AUGMENTS` edges on **≥ 60%** of patterns |
| Use cases | ~30 | Across 6 tracks. Two (`service-catalog`, `cost-management`) deliberately have no solving pattern: framing one yields no candidates, and the skill leaves it unselected and says so at the select gate |
| Build options | ~10 | Three-point build estimates per `CapabilityType` |
| Platform capabilities | ~8 | Harborline coverage per `CapabilityType` |

## Deal and history (`data/deals/`, `data/history/`)
- **Nimbus findings:** each has `evidence_type` and `confidence`. Include absent capabilities with strong evidence (→ gap) and some with weak evidence (→ assumption), plus service `CALLS` edges.
- **History:** at least 5 catalog Tasks must have ≥ 3 `Actual` observations across the history deals (several PlanTasks may instantiate the same Task), so that estimate provenance is demonstrable.

## Planted situations (each must be reproducible 5/5)

| # | Situation | Expected behavior |
|---|---|---|
| P1 | A critical identity gap whose best pattern `REQUIRES` an unselected federation pattern | V1 fails, and the missing pattern is derived and added |
| P2 | Two use cases whose top picks `CONFLICT` | V2 witness, then the agent re-selects the stored near-miss |
| P3 | An EU data-residency finding with no matching label | Guard G6 denies; `propose_term` → gate approves → write succeeds |
| P4 | The architect rejects one selection with a comment | Feedback + Override are written; iteration 2 runs; `iteration_diff` explains the change |
| P5 | One pattern variant has a task cycle (`container-replatform-fastpath`, the top bridge pick for `container-platform-migration` from `f-vm-hosting`) | V3 witness; scheduling refuses to run; the agent switches to the near-miss `container-replatform` (whose prerequisite `landing-zone-onboarding` V1 then derives), and the plan schedules |
| P6 | Buy vs build | SSO → integrate (~6 wk vs ~20 wk build); audit logging → retire (coverage ≥ 0.8); billing ledger → review |

**Authoring vs generation:**
- **Hand-authored** (`data/catalog/*.yaml`, `data/deals/nimbus/planted.yaml`): the catalog (patterns, task DAGs, use cases, tracks, strategies, build options, platform capabilities, knowledge edges) and every finding or edge that a planted situation P1–P6 depends on. Planted structure is never left to randomness.
- **Generated** by `scripts/generate-data.ts` with a fixed seed: filler Nimbus findings and sources, the history deals' plans and `Actual` durations (jittered around the catalog estimates, with the P6 and provenance numbers held exactly), and `data/manifest.json` (expected node and relationship counts per label and type).
- The generator is idempotent: re-running produces no diff. Every number shown in the talk must come from regenerated data.
