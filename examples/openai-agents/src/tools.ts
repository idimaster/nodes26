import { tool, type JsonSchemaDefinition } from '@openai/agents';
import type { PlannerGateway } from '@planner/harness';
import type { PlannerTracing } from './local-tracing.js';

/** Keep canonical routing independent of the SDK's lossy name normalization. */
export function mapPlannerTools(gateway: PlannerGateway, tracing?: PlannerTracing) {
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();
  for (const descriptor of gateway.tools) {
    const name = descriptor.canonicalName;
    const provider = name.replace(/[^a-zA-Z0-9]/g, '_');
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(provider)) throw new Error(`function name must be 1–64 characters: ${name}`);
    if (canonicalToProvider.has(name) || providerToCanonical.has(provider)) throw new Error(`tool name collision: ${name} -> ${provider}`);
    canonicalToProvider.set(name, provider); providerToCanonical.set(provider, name);
  }
  // Match whole canonical tokens, so a longer undeclared reference cannot be partially rewritten.
  const instructions = gateway.instructions.replace(/(?<![a-zA-Z0-9_-])mcp__[a-zA-Z0-9_-]+/g, name => {
    const mapped = canonicalToProvider.get(name);
    if (!mapped) throw new Error(`undeclared tool reference in planner instructions: ${name}`);
    return mapped;
  });
  const tools = gateway.tools.map(descriptor => {
    const name = canonicalToProvider.get(descriptor.canonicalName);
    if (!name) throw new Error(`unmapped tool: ${descriptor.canonicalName}`);
    return tool({
      name,
      description: descriptor.description,
      // SDK 0.21's declaration requires fields that MCP may omit (required, additionalProperties).
      // Plain JSON schemas pass through unchanged in non-strict mode; validation is the gateway's job.
      parameters: structuredClone(descriptor.inputSchema) as Extract<JsonSchemaDefinition['schema'], { additionalProperties: true }>,
      strict: false,
      errorFunction: null,
      execute: async (input, _context, details) => {
        const invoke = async () => {
          const result = await gateway.invoke(descriptor.canonicalName, input, details?.signal);
          tracing?.event('planner.tool_result', { canonical_name: descriptor.canonicalName, is_error: result.isError === true, denied: result.denied === true });
          return JSON.stringify(result);
        };
        const gate = ['mcp__gate__request_approval', 'mcp__gate__await_approval', 'mcp__ontology__propose_term'].includes(descriptor.canonicalName);
        return tracing ? tracing.span(gate ? 'planner.gate_wait' : 'planner.tool', { canonical_name: descriptor.canonicalName }, invoke) : invoke();
      },
    });
  });
  return { instructions, tools, canonicalToProvider, providerToCanonical };
}
