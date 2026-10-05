# 02: Prompt rules are not guardrails

**What we did.** The skill told the agent the Cypher rules: bound every variable-length path, scope every per-deal write by `$deal`, never delete.

**What broke.** Models follow such rules most of the time, which is not the same as always. Neo4j has no idea what the prompt said. An unbounded `[:DEPENDS_ON*]`, an unscoped `SET` that edits every deal's selections, and a `DETACH DELETE` all run (in the test, the unscoped edit rewrites the committed selections of two other deals).

**The fix.** The rules live in code. The write guard (`packages/guard`) runs as a PreToolUse hook on every `write-cypher` call and denies the statement, with an actionable reason the agent can repair from:
- **G4**: every variable-length pattern is bounded (≤ 10 hops);
- **G5**: a per-deal write must use `$deal`;
- **G2**: no `DELETE`, `DETACH DELETE`, `REMOVE` of keys, or admin commands.

- Before: [`before.cypher`](before.cypher)
- After: [`after.ts`](after.ts), using `guard.validate`
- Test: [`test.ts`](test.ts)
