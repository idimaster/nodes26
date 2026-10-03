# Demo data contract (all fictional)

## Universe
- **Harborline Software** (acquirer): B2B SaaS platform. Its platform capabilities (corporate IdP, API gateway, audit-log pipeline, event bus, billing platform) are modeled as `PlatformCapability` nodes with `coverage` per `CapabilityType`.
- **Nimbus Ledger** (target; `deal_code: nimbus`): accounting and AP-automation SaaS with about 25 findings across identity, security, API, data, infrastructure, and operations.
- **History:** two completed integrations, `tidewater` (analytics startup) and `quarry` (document-capture vendor). Committed plans plus `Actual` durations on about 40 tasks.

**Naming rule:** no names of real companies, products, or deals. CI runs `scripts/denylist-check.ts`, which reads denylisted terms from `$DENYLIST_FILE` (stored **outside** this repo) and fails on any match.

## Catalog (`data/catalog/`)

| Asset | Count | Requirements |
|---|---|---|
| Patterns | ~25 | Task DAG with three-point estimates and a `skill` ∈ {identity, platform, data, security, frontend, ops}; `solves_use_cases`; `applicable_strategies` ⊆ {bridge, transform}; `reference` to a public standard or practice (e.g. SAML 2.0, OIDC, SCIM, strangler fig, CDC replication, API gateway facade); `not_recommended_when` rules on ≥ 5 patterns; `REQUIRES`/`CONFLICTS`/`AUGMENTS` edges on **≥ 60%** of patterns |
| Use cases | ~30 | Across 6 tracks |
| Build options | ~10 | Three-point build estimates per `CapabilityType` |
| Platform capabilities | ~8 | Harborline coverage per `CapabilityType` |

## Deal and history (`data/deals/`, `data/history/`)
- **Nimbus findings:** each has `evidence_type` and `confidence`. Include absent capabilities with strong evidence (→ gap) and some with weak evidence (→ assumption), plus service `CALLS` edges.
- **History:** at least 5 tasks must have ≥ 3 `Actual` observations, so that estimate provenance is demonstrable.

## Planted situations (each must be reproducible 5/5)

| # | Situation | Expected behavior |
|---|---|---|
| P1 | A critical identity gap whose best pattern `REQUIRES` an unselected federation pattern | V1 fails, and the missing pattern is derived and added |
| P2 | Two use cases whose top picks `CONFLICT` | V2 witness, then the agent re-selects the stored near-miss |
| P3 | An EU data-residency finding with no matching label | Guard G6 denies; `propose_term` → gate approves → write succeeds |
| P4 | The architect rejects one selection with a comment | Feedback + Override are written; iteration 2 runs; `iteration_diff` explains the change |
| P5 | One pattern variant has a task cycle | V3 witness; scheduling refuses to run |
| P6 | Buy vs build | SSO → integrate (~6 wk vs ~20 wk build); audit logging → retire (coverage ≥ 0.8); billing ledger → review |

**Generation:** `scripts/generate-data.ts` uses a fixed seed and is idempotent. Every number shown in the talk must come from regenerated data.
