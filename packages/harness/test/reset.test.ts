import { expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { neo4jConfig } from '../../../graph/connection.js';
import { assertComposeIdentity, verifyResetTarget } from '../src/reset.js';

const container = { Config: { Env: ['NEO4J_AUTH=neo4j/planner-demo'] }, NetworkSettings: { Ports: { '7687/tcp': [{ HostIp: '0.0.0.0', HostPort: '7687' }] } }, State: { Running: true } };
it('requires the local Compose endpoint, published port, default user and actual password', () => {
  expect(() => assertComposeIdentity(neo4jConfig({}), container)).not.toThrow();
  for (const graph of [
    { ...neo4jConfig({}), uri: 'bolt://remote.invalid:7687' },
    { ...neo4jConfig({}), uri: 'bolt://localhost:9999' },
    { ...neo4jConfig({}), user: 'other' },
    { ...neo4jConfig({}), password: 'wrong' },
  ]) expect(() => assertComposeIdentity(graph, container)).toThrow();
});
it('rejects a remote Docker daemon before any database access', async () => {
  const executeQuery = vi.fn();
  await expect(verifyResetTarget('.', neo4jConfig({}), { executeQuery } as unknown as Driver, { DOCKER_HOST: 'tcp://remote.invalid:2375' })).rejects.toThrow(/no deletion performed/);
  expect(executeQuery).not.toHaveBeenCalled();
});
