# 06: Feedback lost in chat

**What we did.** The architect reviewed in the chat, and the agent re-planned by editing the plan in place. At most, the comment was saved as a text property.

**What broke.** At the next review, the architect asked: "what changed since my review, and why?" The graph only held the present state. The pattern they had rejected was overwritten, and the comment was a string tied to nothing: not to the gate, not to the selection it was about, and not to the change that answered it.

**The fix.** Make the review loop part of the model:
- **Iteration.** Every re-plan is a new `Iteration`, and nothing is overwritten.
- **Feedback.** A rejection writes `Feedback` (`ON` the rejected selection, `FROM` the gate), plus the `Override`s parsed from the comment, for example `exclude_pattern cdc-replication`.
- **RESOLVED_BY.** When the new plan addresses the feedback, `resolve_feedback` links it `RESOLVED_BY` the new selection.
- **iteration_diff.** The skill's query lists each change against the previous iteration, together with the feedback that drove it.

- Before: [`before.cypher`](before.cypher)
- After: [`after.ts`](after.ts), using `GateStore.decide`, `GateStore.resolveFeedback`, and `graph/queries/skill/iteration_diff.cypher`
- Test: [`test.ts`](test.ts)
