import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gatewayDefinition } from '../src/definition.js';

const root = new URL('../../..', import.meta.url).pathname;
const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-definition-')); directories.push(dir);
  mkdirSync(join(dir, 'plugin/agents'), { recursive: true });
  writeFileSync(join(dir, 'plugin/agents/planner.md'), readFileSync(join(root, 'plugin/agents/planner.md')));
  writeFileSync(join(dir, '.mcp.json'), readFileSync(join(root, '.mcp.json')));
  return dir;
}
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it.each(['--uri', '--neo4j-uri', '--database', '--username', '--password'])('rejects %s identity flags before any child starts', flag => {
  const dir = fixture();
  const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  config.mcpServers['neo4j-write']!.args.push(flag, 'other');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config));
  expect(() => gatewayDefinition(dir)).toThrow(/graph CLI overrides/);
});

it.each(['', 'mcp__unknown__tool', 'mcp__neo4j-read__get-schema, mcp__neo4j-read__get-schema'])('rejects malformed/duplicate/incomplete allowlists: %s', tools => {
  const dir = fixture();
  writeFileSync(join(dir, 'plugin/agents/planner.md'), `---\ntools: ${tools}\n---\nPlan integrations.`);
  expect(() => gatewayDefinition(dir)).toThrow(/allowlist/);
});

it('rejects an empty prompt even with a valid allowlist', () => {
  const dir = fixture();
  const agent = readFileSync(join(dir, 'plugin/agents/planner.md'), 'utf8');
  writeFileSync(join(dir, 'plugin/agents/planner.md'), agent.slice(0, agent.indexOf('\n---\n', 4) + 5) + '\n  \n');
  expect(() => gatewayDefinition(dir)).toThrow(/nonempty instructions/);
});
