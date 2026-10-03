export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

/** Connection settings for tests; defaults match docker-compose.yml. */
export function neo4jConfig(env: NodeJS.ProcessEnv = process.env): Neo4jConfig {
  return {
    uri: env.NEO4J_URI ?? 'neo4j://localhost:7687',
    user: env.NEO4J_USERNAME ?? 'neo4j',
    password: env.NEO4J_PASSWORD ?? 'planner-demo',
  };
}
