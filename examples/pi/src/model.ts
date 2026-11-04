import { createModels, type Provider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

/** No settings discovery, shell credentials or ambient coding tools. Catalog lookup is offline. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const spec = env.PLANNER_MODEL ?? 'anthropic:claude-sonnet-5-5';
  const separator = spec.indexOf(':');
  const providerId = spec.slice(0, separator);
  const id = spec.slice(separator + 1);
  if (separator < 1 || !id || !['anthropic', 'openai'].includes(providerId)) throw new Error('PLANNER_MODEL provider must be anthropic:<id> or openai:<id>');
  const credential = providerId === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  if (!env[credential]?.trim()) throw new Error(`missing ${credential}`);
  const models = createModels({ authContext: { env: async name => env[name], fileExists: async () => false } });
  let provider: Provider = providerId === 'anthropic' ? anthropicProvider() : openaiProvider();
  const baseUrl = providerId === 'anthropic' ? env.ANTHROPIC_BASE_URL : undefined;
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid ANTHROPIC_BASE_URL');
    const original = provider;
    provider = { ...original, baseUrl, getModels: () => original.getModels().map(model => ({ ...model, baseUrl })) };
  }
  models.setProvider(provider);
  const model = models.getModel(providerId, id);
  if (!model) throw new Error(`model ${spec} is absent from Pi 1.5.0's tool-capable catalog; select an explicit PLANNER_MODEL (the baseline is never silently replaced)`);
  return { model, streamFn: models.streamSimple.bind(models) };
}
