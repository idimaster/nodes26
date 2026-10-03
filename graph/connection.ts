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
