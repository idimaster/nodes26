import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { Driver } from 'neo4j-driver';
import { assertGraphEnvironment, type Neo4jConfig } from '../../../graph/connection.js';
import { loadAll } from '../../../graph/load/index.js';
import { snapshotRetainedTerms } from '../../../graph/load/verify.js';
import { DATA_DIR } from '@planner/data';
import { assertNoManagedRun } from './lock.js';
import { assertFreshRun, RESET_SCOPE } from './recovery.js';

const run = promisify(execFile);
const rancherDocker = '/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker';
export const dockerCommand = () => existsSync(rancherDocker) ? rancherDocker : 'docker';
interface ContainerInfo { Config: { Env: string[] }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> }; State: { Running: boolean } }

export function assertComposeIdentity(graph: Neo4jConfig, container: ContainerInfo): void {
  const uri = new URL(graph.uri);
  if (!['neo4j:', 'bolt:'].includes(uri.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) || uri.username || uri.password || (uri.pathname && uri.pathname !== '/') || uri.search || uri.hash || graph.user !== 'neo4j') throw new Error('reset supports only the local Compose Neo4j endpoint/default user');
  const bindings = container.NetworkSettings.Ports['7687/tcp'];
  if (!container.State.Running || !bindings?.some(p => p.HostPort === (uri.port || '7687'))) throw new Error('reset target does not match the Compose published Bolt port');
  const auth = container.Config.Env.find(v => v.startsWith('NEO4J_AUTH='))?.slice('NEO4J_AUTH='.length);
  if (auth !== `neo4j/${graph.password}`) throw new Error('reset credentials do not match the Compose service');
}

/** Validate the actual repository Compose service before any destructive query. */
export async function verifyResetTarget(root: string, graph: Neo4jConfig, driver: Driver, env: NodeJS.ProcessEnv = process.env) {
  assertGraphEnvironment(graph, env);
  const options = { cwd: root, env, timeout: 10_000, maxBuffer: 1_000_000 };
  try {
    const endpoint = env.DOCKER_HOST && !env.DOCKER_CONTEXT ? env.DOCKER_HOST
      : JSON.parse((await run(dockerCommand(), ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], options)).stdout) as string;
    if (!endpoint.startsWith('unix://')) throw new Error('reset requires a local Docker socket/context');
    const { stdout } = await run(dockerCommand(), ['compose', 'ps', '-q', 'neo4j'], options);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw new Error('cannot identify one running repository Compose Neo4j service');
    const inspected = await run(dockerCommand(), ['inspect', ids[0] ?? ''], options);
    const containers = JSON.parse(inspected.stdout) as ContainerInfo[];
    if (containers.length !== 1 || !containers[0]) throw new Error('unverifiable Compose target');
    assertComposeIdentity(graph, containers[0]);
    const query = 'CALL db.info() YIELD id RETURN id';
    const graphId = (await driver.executeQuery(query, {}, { routing: 'READ' })).records[0]?.get('id') as unknown;
    const inside = await run(dockerCommand(), ['compose', 'exec', '-T', 'neo4j', 'cypher-shell', '-u', graph.user, '-p', graph.password, '--format', 'plain', query], options);
    const lines = inside.stdout.trim().split(/\r?\n/);
    const composeId: unknown = lines.length === 2 ? JSON.parse(lines[1] ?? 'null') : null;
    if (typeof graphId !== 'string' || composeId !== graphId) throw new Error('host and Compose database identities differ');
  } catch (error) {
    // execFile errors can include argv (including the password); never surface that text.
    throw new Error('reset target could not be verified as the same local Compose database; no deletion performed', { cause: error });
  }
}

export async function resetDemo(options: { root: string; graph: Neo4jConfig; driver: Driver; deal: string; env?: NodeJS.ProcessEnv }) {
  console.log(RESET_SCOPE);
  await assertNoManagedRun(options.root);
  await verifyResetTarget(options.root, options.graph, options.driver, options.env);
  await options.driver.verifyConnectivity();
  const terms = await snapshotRetainedTerms(options.driver);
  console.log(`reset-demo: preserving ${terms.length} active global term(s); wiping all per-deal subgraphs`);
  await options.driver.executeQuery(
    `MATCH (n) WHERE n:Deal OR n.deal_code IS NOT NULL OR (n:OntologyTerm AND n.scope <> 'global') DETACH DELETE n RETURN count(*) AS deleted`,
  );
  await loadAll(options.driver, DATA_DIR, 'retain-active-global-terms');
  if (!isDeepStrictEqual(await snapshotRetainedTerms(options.driver), terms)) throw new Error('DATASET_NOT_READY: retained global term metadata changed during reset');
  const result = await assertFreshRun(options.driver, options.deal);
  console.log(`reset-demo: baseline verified; retained global terms: ${result.readiness.retainedTerms.join(', ') || 'none'}`);
}
