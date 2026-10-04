import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The guard hook is registered for the tool that .mcp.json actually serves, and points at the real script. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as {
  hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
};
const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };

describe.each([
  ['hooks/hooks.json (plugin)', 'hooks/hooks.json', '${CLAUDE_PLUGIN_ROOT}'],
  ['.claude/settings.json (project)', '.claude/settings.json', '$CLAUDE_PROJECT_DIR'],
])('%s', (_name, file, rootVar) => {
  const entries = read(file).hooks.PreToolUse;

  it('guards exactly mcp__neo4j-write__write-cypher, a server .mcp.json declares', () => {
    expect(entries.map((e) => e.matcher)).toEqual(['mcp__neo4j-write__write-cypher']);
    expect(Object.keys(mcp.mcpServers)).toContain('neo4j-write');
  });

  it('runs the guard hook script that exists in this repo', () => {
    const [hook] = entries[0]?.hooks ?? [];
    expect(hook?.type).toBe('command');
    expect(hook?.command).toBe(`"${rootVar}/node_modules/.bin/tsx" "${rootVar}/packages/guard/bin/guard-hook.ts"`);
    expect(existsSync(join(ROOT, 'packages/guard/bin/guard-hook.ts'))).toBe(true);
    expect(hook?.timeout).toBeGreaterThanOrEqual(10);
  });
});
