import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Driver } from 'neo4j-driver';
import { loadContext, validate, type GuardContext } from '@planner/guard';
import { assertGraphEnvironment, graphEnvironment, neo4jConfig, type Neo4jConfig } from '../../../graph/connection.js';
import { auditLogger } from './audit.js';
import { CANONICAL, gatewayDefinition, WRITE_TOOL } from './definition.js';
import type { Connection, GuardAudit, PlannerGateway, ToolDescriptor, ToolOutcome } from './types.js';

export const MCP_TIMEOUT_MS = 60_000;
const deny = (reason: string): ToolOutcome => ({ denied: true, reason, isError: true, content: [{ type: 'text', text: JSON.stringify({ denied: true, reason }) }] });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Close all resources, including partially connected transports; retain the primary failure. */
export async function cleanupAll(closers: (() => Promise<unknown>)[], primary?: unknown): Promise<void> {
  const results = await Promise.allSettled(closers.map(close => Promise.resolve().then(close)));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason as unknown);
  if (primary !== undefined) {
    if (errors.length) console.error(`harness: ${errors.length} secondary cleanup failure(s)`);
    throw primary;
  }
  if (errors.length) throw new AggregateError(errors, 'harness cleanup failed');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function createGateway(options: {
  root: string; driver: Driver; deal: string; graph?: Neo4jConfig; env?: Record<string, string>;
  signal?: AbortSignal; runId?: string;
  connect?: (server: string, parameters: StdioServerParameters) => Promise<Connection>;
  context?: (driver: Driver, deal: string) => Promise<GuardContext>;
  audit?: (decision: GuardAudit) => Promise<void>;
}): Promise<PlannerGateway> {
  const { instructions, tools: allowlist, servers } = gatewayDefinition(options.root);
  const graph = options.graph ?? neo4jConfig();
  const runId = options.runId ?? randomUUID();
  const audit = options.audit ?? auditLogger(options.root, { ...process.env, ...options.env });
  assertGraphEnvironment(graph, process.env, options.env ?? {}, ...Object.values(servers).map(s => s.env));
  for (const source of [process.env, options.env ?? {}, ...Object.values(servers).map(s => s.env)]) {
    if (source.GATE_HTTP !== undefined && source.GATE_HTTP !== 'off') throw new Error('managed gateway requires GATE_HTTP=off');
  }
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  const closers: (() => Promise<unknown>)[] = [];
  const bindings = new Map<string, { connection: Connection; name: string; check: ReturnType<AjvJsonSchemaValidator['getValidator']> }>();
  const descriptors: ToolDescriptor[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  const close = () => {
    if (!closePromise) {
      closed = true; abort.abort();
      closePromise = cleanupAll(closers);
    }
    return closePromise;
  };
  try {
    for (const [serverName, entry] of Object.entries(servers)) {
      signal.throwIfAborted();
      const env = Object.fromEntries(Object.entries({ ...process.env, ...entry.env, ...options.env, ...graphEnvironment(graph), GATE_HTTP: 'off' }).filter((e): e is [string, string] => typeof e[1] === 'string'));
      const parameters: StdioServerParameters = { command: entry.command, args: entry.args, cwd: options.root, env, stderr: 'pipe' };
      let connection: Connection;
      if (options.connect) {
        connection = await options.connect(serverName, parameters);
        closers.push(() => connection.close());
      } else {
        const transport = new StdioClientTransport(parameters);
        closers.push(() => transport.close());
        // Diagnostics are outside the model transcript; do not print inherited credentials.
        let diagnostics = '';
        transport.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
        const client = new Client({ name: 'planner-pi', version: '0.1.0' });
        closers.push(() => client.close());
        try { await client.connect(transport, { timeout: MCP_TIMEOUT_MS, signal }); }
        catch (error) { throw new Error(`MCP connection failed for ${serverName} (stderr retained: ${diagnostics.length} bytes)`, { cause: error }); }
        connection = {
          listTools: async () => {
            const tools = [];
            let cursor: string | undefined;
            do {
              const page = await client.listTools(cursor ? { cursor } : {}, { timeout: MCP_TIMEOUT_MS, signal });
              tools.push(...page.tools); cursor = page.nextCursor;
            } while (cursor);
            return tools;
          },
          callTool: async (name, input, callSignal) => CallToolResultSchema.parse(await client.callTool({ name, arguments: input }, CallToolResultSchema, { timeout: MCP_TIMEOUT_MS, signal: callSignal })),
          close: () => client.close(),
        };
      }
      const validator = new AjvJsonSchemaValidator();
      for (const tool of await connection.listTools()) {
        const canonicalName = `mcp__${serverName}__${tool.name}`;
        if (!allowlist.includes(canonicalName)) continue;
        if (bindings.has(canonicalName)) throw new Error(`duplicate discovered tool ${canonicalName}`);
        bindings.set(canonicalName, { connection, name: tool.name, check: validator.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]) });
        descriptors.push(freeze({ canonicalName, description: tool.description ?? tool.name, inputSchema: structuredClone(tool.inputSchema) }));
      }
    }
    const missing = allowlist.filter(name => !bindings.has(name));
    if (missing.length) throw new Error(`allowlisted tools not served: ${missing.join(', ')}`);
    signal.throwIfAborted();
  } catch (error) { await cleanupAll(closers, error); throw error; }

  async function execute(name: string, input: unknown, callerSignal?: AbortSignal): Promise<ToolOutcome> {
    const callSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
    callSignal.throwIfAborted();
    if (closed) throw new Error('gateway is closed');
    if (failure) throw failure;
    const binding = bindings.get(name);
    if (!CANONICAL.test(name) || !binding) return deny(`tool is not allowlisted: ${name}`);
    const checked = binding.check(input);
    let reason: string | undefined;
    if (!checked.valid || !object(input)) reason = `invalid tool arguments: ${checked.errorMessage ?? 'object required'}`;
    else if ('deal' in input && input.deal !== options.deal) reason = `deal must match selected deal ${options.deal}`;
    else if (object(input.params) && 'deal' in input.params && input.params.deal !== options.deal) reason = `params.deal must match selected deal ${options.deal}`;
    else if (name === WRITE_TOOL && (typeof input.query !== 'string' || !object(input.params) || input.params.deal !== options.deal)) reason = `write requires string query and object params with deal ${options.deal}`;
    const log = async (allow: boolean, why: string, rules: string[] = []) => audit({ time: new Date().toISOString(), host: 'pi', runId, canonicalName: name, deal: options.deal, allow, rules, reason: why });
    if (reason) { if (name === WRITE_TOOL) await log(false, reason); return deny(reason); }
    // Local validation establishes an object; preserve the original argument values unchanged.
    const args = input as Record<string, unknown>;
    try {
      if (name === 'mcp__gate__await_approval') {
        const result = await options.driver.executeQuery('MATCH (g:GateDecision {id: $id}) RETURN g.deal_code AS deal', { id: args.gate_id }, { routing: 'READ' });
        if (result.records.length !== 1 || result.records[0]?.get('deal') !== options.deal) return deny(`gate does not belong to selected deal ${options.deal}`);
      }
      if (name === WRITE_TOOL) {
        const context = await (options.context ?? loadContext)(options.driver, options.deal);
        const decision = await validate(args.query as string, args.params as Record<string, unknown>, context);
        await log(decision.allow, decision.allow ? 'allowed' : decision.reason, decision.allow ? [] : decision.violations.map(v => v.rule));
        if (!decision.allow) return deny(decision.reason ?? 'write denied');
      }
      callSignal.throwIfAborted();
      const result = await binding.connection.callTool(binding.name, args, callSignal);
      for (const item of result.content) if (item.type !== 'text') throw new Error(`unsupported MCP content ${item.type} from ${name}`);
      return result;
    } catch (error) {
      failure = error; abort.abort();
      throw error;
    }
  }
  return {
    instructions: `${instructions}\n\nThis run is bound to deal ${JSON.stringify(options.deal)}. Every deal argument must match it.`,
    tools: Object.freeze(descriptors.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))),
    invoke(name, input, callerSignal) {
      const job = queue.then(() => execute(name, input, callerSignal));
      queue = job.catch(() => undefined);
      return job;
    }, close,
  };
}
