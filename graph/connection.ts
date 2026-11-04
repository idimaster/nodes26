import neo4j, { type Driver } from 'neo4j-driver';

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

/** Connection settings from the environment; defaults match docker-compose.yml. */
export function neo4jConfig(env: NodeJS.ProcessEnv = process.env): Neo4jConfig {
  return {
    uri: env.NEO4J_URI ?? 'neo4j://localhost:7687',
    user: env.NEO4J_USERNAME ?? 'neo4j',
    password: env.NEO4J_PASSWORD ?? 'planner-demo',
  };
}

export function openDriver(config: Neo4jConfig = neo4jConfig()): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

const graphKeys = {
  NEO4J_URI: 'uri', NEO4J_MCP_URI: 'uri',
  NEO4J_USERNAME: 'user', NEO4J_MCP_USERNAME: 'user',
  NEO4J_PASSWORD: 'password', NEO4J_MCP_PASSWORD: 'password',
} as const;

/** Graph identity is immutable across the guard, all children and the owned console. */
export function assertGraphEnvironment(config: Neo4jConfig, ...sources: NodeJS.ProcessEnv[]): void {
  for (const env of sources) {
    for (const [key, property] of Object.entries(graphKeys)) {
      if (env[key] !== undefined && env[key] !== config[property]) throw new Error(`conflicting graph setting ${key}`);
    }
    for (const key of ['NEO4J_DATABASE', 'NEO4J_MCP_DATABASE']) {
      if (env[key] !== undefined && env[key] !== 'neo4j') throw new Error(`custom database setting ${key} is unsupported`);
    }
  }
}

export function graphEnvironment(config: Neo4jConfig): Record<string, string> {
  return { NEO4J_URI: config.uri, NEO4J_USERNAME: config.user, NEO4J_PASSWORD: config.password, NEO4J_DATABASE: 'neo4j',
    NEO4J_MCP_URI: config.uri, NEO4J_MCP_USERNAME: config.user, NEO4J_MCP_PASSWORD: config.password, NEO4J_MCP_DATABASE: 'neo4j' };
}

export interface ManagedConfig { token: string; graph: Neo4jConfig; port: number }
export function managedConfig(env: NodeJS.ProcessEnv = process.env): ManagedConfig | undefined {
  if (env.PLANNER_MANAGED_CONFIG === undefined) {
    if (env.PLANNER_MANAGED_TOKEN) throw new Error('missing managed launch configuration');
    return undefined;
  }
  let config: ManagedConfig;
  try { config = JSON.parse(env.PLANNER_MANAGED_CONFIG) as ManagedConfig; } catch { throw new Error('invalid managed launch configuration'); }
  if (!config || typeof config.token !== 'string' || config.token.length < 16 || config.token !== env.PLANNER_MANAGED_TOKEN ||
      !config.graph || !['uri', 'user', 'password'].every(k => typeof (config.graph as unknown as Record<string, unknown>)[k] === 'string') ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('invalid managed launch configuration');
  assertGraphEnvironment(config.graph, env);
  if (env.GATE_PORT !== String(config.port)) throw new Error('managed console port mismatch');
  return config;
}
