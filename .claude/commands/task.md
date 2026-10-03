---
description: Implement one milestone task (e.g. /task T2.4) — plan, tests first, implement, verify, commit
argument-hint: T<milestone>.<n>
---

Implement task **$ARGUMENTS**.

1. **Load context.** Read `docs/design/DESIGN.md` (the contract), `docs/design/DATA.md` and `docs/design/GOTCHAS.md` as relevant, and the milestone file `docs/milestones/M<n>.md` that contains `$ARGUMENTS`. Quote the task's **Scope** and **Acceptance** back in one short block.
2. **Check order.** Confirm earlier tasks in the same milestone are done (look at `git log --oneline` for `T<id>:` commits). If a prerequisite is missing, stop and say so. Never start a task from a later milestone.
3. **Plan.** For non-trivial tasks, propose a design mapped to each acceptance criterion and wait for approval. If the task conflicts with or is under-specified by DESIGN, propose the DESIGN change in the same plan.
4. **Tests first.** Write tests derived from the acceptance criteria; run them and confirm they fail for the right reason.
5. **Implement** until green. Keep the diff focused on this task. Follow the CLAUDE.md hard rules (engine purity, reserved labels, Cypher style, no silent fallbacks, determinism, public-repo hygiene).
6. **Verify.** Run `/verify`. For correctness-critical tasks (guard, gate, validators, scheduling, buy-vs-build) also run the `spec-reviewer` subagent and address its findings.
7. **Commit** with message `$ARGUMENTS: <title from milestone file>`. If DESIGN changed, it goes in the same commit.
8. **Report** each acceptance criterion as met / not met with evidence (command + result).
