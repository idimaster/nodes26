# 03: Tool allowlist drift

**What we did.** The agent's tools are named in three places: the skill text (which tools to call), the agent's `tools:` frontmatter (what it may call), and `.mcp.json` (what is actually served). We kept them in sync by hand.

**What broke.** They drift. When the ontology server and server-side scheduling arrived, the skill started calling `mcp__ontology__get_ontology`, `mcp__ontology__propose_term`, and `mcp__planner-graph__schedule_plan`, while the agent still granted the old engine-side `compute_schedule` the skill no longer uses. The agent file still loads. The failure shows up mid-plan, as a denied tool call the model then tries to work around.

**The fix.** `npm run check:tools` (`scripts/check-tool-surface.ts`) launches every `.mcp.json` server, lists its tools, and asserts:
- skill tools = agent tools ⊆ served tools;
- every served write tool is matched by a PreToolUse guard hook.

It runs in CI (`.github/workflows/checks.yml`), so drift fails the build instead of the demo.

- Before: [`before.ts`](before.ts) against the stale [`fixture-agent.md`](fixture-agent.md)
- After: [`after.ts`](after.ts), using `runCheck`
- Test: [`test.ts`](test.ts)
