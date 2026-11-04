import { Usage, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';

export const toolCall = (name: string, input: unknown, id = 'call-1'): ModelResponse => ({
  usage: new Usage({ requests: 1 }),
  output: [{ type: 'function_call', name, arguments: JSON.stringify(input), callId: id }],
});
export const answer = (text = 'Done'): ModelResponse => ({
  usage: new Usage({ requests: 1 }),
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
});

export function scriptedModel(respond: (request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>) {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request) { requests.push(request); return respond(request, requests.length - 1); },
    getStreamedResponse() { throw new Error('streaming is outside this adapter'); },
  };
  return { model, requests };
}
