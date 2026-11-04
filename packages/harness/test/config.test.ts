import { expect, it } from 'vitest';
import { assertGraphEnvironment, managedConfig, neo4jConfig } from '../../../graph/connection.js';

it('rejects graph identity drift and custom database settings before launch', () => {
  const graph = neo4jConfig({});
  expect(() => assertGraphEnvironment(graph, { NEO4J_MCP_URI: 'neo4j://localhost:9999' })).toThrow('conflicting graph');
  expect(() => assertGraphEnvironment(graph, { NEO4J_DATABASE: 'other' })).toThrow('custom database');
});
it('requires the managed token, graph environment and port to agree', () => {
  const config = { token: 'test-launch-token-123', graph: neo4jConfig({}), port: 4646 };
  const env = { PLANNER_MANAGED_CONFIG: JSON.stringify(config), PLANNER_MANAGED_TOKEN: config.token, GATE_PORT: '4646' };
  expect(managedConfig(env)).toEqual(config);
  expect(() => managedConfig({ ...env, PLANNER_MANAGED_TOKEN: 'wrong' })).toThrow('invalid managed');
  expect(() => managedConfig({ ...env, NEO4J_URI: 'neo4j://localhost:9999' })).toThrow('conflicting graph');
});
