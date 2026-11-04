export function modelFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const match = /^openai:([^\s:]+)$/.exec(env.PLANNER_MODEL ?? '');
  if (!match?.[1]) throw new Error('set explicit PLANNER_MODEL=openai:<model-id>');
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (env.OPENAI_BASE_URL || env.OPENAI_WEBSOCKET_BASE_URL) throw new Error('custom OpenAI endpoints are outside this example');
  return { modelId: match[1], apiKey };
}
