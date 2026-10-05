import { agentToolNames } from '../../scripts/check-tool-surface.js';

/**
 * Before: the only check is that the agent file loads: it has a name and a tool list. That stays true
 * while the skill, the agent's allowlist, and the served tools drift apart. The agent then fails at run
 * time, mid-plan, when it calls a tool it was never granted.
 */
export function agentFileLoads(markdown: string): boolean {
  const name = /^name:\s*\S+/m.test(/^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '');
  return name && agentToolNames(markdown).length > 0;
}
