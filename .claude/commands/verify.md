---
description: Run all checks (lint, typecheck, tests, denylist) and report against the current task's acceptance criteria
---

Run the project checks and report honestly.

1. Confirm Neo4j is up: `docker compose ps` shows the neo4j service healthy. If not, run `docker compose up -d` and wait for health.
2. Run, in order, stopping at the first failure only to report it (do not hide failures):
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run denylist` — if `$DENYLIST_FILE` is unset, report that the check was **skipped**, never "passed".
   Scripts that don't exist yet (early M1) are reported as "not yet defined", not as passing.
3. Run `git status --short` and flag untracked or modified files that don't belong to the current task.
4. Report a table: check → pass / fail / skipped, with the failing output excerpt.
5. If a task is in progress, list each of its acceptance criteria as met / not met with the evidence.
