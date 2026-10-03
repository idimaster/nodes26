---
description: Work through a whole milestone (e.g. /milestone M2) task by task
argument-hint: M<n>
---

Work through milestone **$ARGUMENTS** from `docs/milestones/$ARGUMENTS.md`.

1. List the milestone's tasks and mark which are already done (a `T<id>:` commit exists in `git log`).
2. For each remaining task, in table order, follow `/task <id>` exactly — including the plan-approval stop for non-trivial tasks and one commit per task.
3. Stop immediately if a task fails `/verify` and cannot be fixed within its own scope; report what is blocking.
4. When all tasks are done, check the milestone's **Exit criteria** one by one with evidence and report. Do not start the next milestone.
