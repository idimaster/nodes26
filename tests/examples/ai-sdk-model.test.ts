import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { modelFromEnv } from '../../examples/ai-sdk/src/agent.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { PLANNER_MODEL: 'openai:gpt-6-luna', OPENAI_API_KEY: 'test-key' },
  { PLANNER_MODEL: 'openai:gpt-6-luna', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://proxy.example/v1' },
  { PLANNER_MODEL: 'openai-compatible:gpt-6-luna', OPENAI_COMPATIBLE_API_KEY: 'test-key', OPENAI_COMPATIBLE_BASE_URL: 'https://api.openai.com/v1' },
  { PLANNER_MODEL: 'openai-compatible:gpt-6-luna', OPENAI_COMPATIBLE_API_KEY: 'test-key', OPENAI_COMPATIBLE_BASE_URL: 'https://api.openai.com/v1/' },
])('uses Responses for OpenAI function calls (configuration %#)', async env => {
  const requests: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown>, authorization: new Headers(init.headers).get('authorization') });
    return Response.json({
      id: `resp_${requests.length}`, object: 'response', created_at: 1, model: 'gpt-6-luna', status: 'completed',
      output: requests.length === 1
        ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"deal":"nimbus"}', status: 'completed' }]
        : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }));
  const execute = vi.fn(async ({ deal }: { deal: string }) => ({ deal, ready: true }));
  const result = await generateText({
    model: modelFromEnv(env), prompt: 'Look up Nimbus.', stopWhen: stepCountIs(2),
    tools: { lookup: tool({ inputSchema: jsonSchema<{ deal: string }>({ type: 'object', properties: { deal: { type: 'string' } }, required: ['deal'], additionalProperties: false }), execute }) },
  });
  expect(result.text).toBe('Ready.');
  expect(execute).toHaveBeenCalledExactlyOnceWith({ deal: 'nimbus' }, expect.anything());
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.url).toBe(`${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/responses`);
    expect(request.authorization).toBe('Bearer test-key');
    expect(request.body.model).toBe('gpt-6-luna');
    expect(request.body.tools).toContainEqual(expect.objectContaining({ type: 'function', name: 'lookup' }));
  }
  expect(requests[1]?.body.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }));
});

it('keeps other OpenAI-compatible servers on Chat Completions', async () => {
  const fetch = vi.fn(async () => Response.json({
    id: 'chat_1', object: 'chat.completion', created: 1, model: 'some-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  vi.stubGlobal('fetch', fetch);
  const result = await generateText({ model: modelFromEnv({
    PLANNER_MODEL: 'openai-compatible:some-model', OPENAI_COMPATIBLE_BASE_URL: 'https://compatible.example/v1', OPENAI_COMPATIBLE_API_KEY: 'compatible-key',
  }), prompt: 'Hello.' });
  expect(result.text).toBe('Ready.');
  expect(fetch).toHaveBeenCalledWith('https://compatible.example/v1/chat/completions', expect.anything());
});
