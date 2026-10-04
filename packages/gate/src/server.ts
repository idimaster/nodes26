import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GateError, type GateStore } from './store.js';

const ok = (result: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(result) }],
  structuredContent: { result },
});
const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: e instanceof GateError ? e.code : 'internal', message: e instanceof Error ? e.message : String(e) }) }],
});

/** MCP tools of DESIGN §4. waitSeconds bounds each long-poll (default 50, below the host's tool timeout). */
export function createGateMcpServer(store: GateStore, waitSeconds: number): McpServer {
  const server = new McpServer({ name: 'gate', version: '0.1.0' });
  const id = z.string().min(1);
  const iteration = z.number().int().positive();

  server.registerTool(
    'request_approval',
    {
      description: `Ask the architect to approve a gate. Writes a pending GateDecision with DECIDED_ON to each subject (e.g. Selection:<uc>, PlanTask:<id>, OntologyTerm:label/<Name>), shows it in the console, and waits up to ${waitSeconds}s. Returns {status, gate_id, feedback_ids, overrides}; if still pending, call await_approval.`,
      inputSchema: z.object({
        deal: id,
        iteration,
        gate: z.enum(['frame', 'select', 'commit', 'ontology_term', 'ontology_promote']),
        subject_ids: z.array(id).min(1),
        summary: z.string().min(1),
      }),
    },
    async (input) => {
      try {
        const { gate_id } = await store.requestGate(input);
        return ok(await store.waitForDecision(gate_id, waitSeconds));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'await_approval',
    {
      description: `Keep waiting (up to ${waitSeconds}s) for a pending gate. Call it again while the status is pending.`,
      inputSchema: z.object({ gate_id: id }),
    },
    async ({ gate_id }) => {
      try {
        return ok(await store.waitForDecision(gate_id, waitSeconds));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'resolve_feedback',
    {
      description:
        'Mark open Feedback as resolved by plan nodes of the given iteration (e.g. the new Selection). Writes RESOLVED_BY; agents cannot write Feedback themselves.',
      inputSchema: z.object({ deal: id, iteration, feedback_id: id, resolved_by_ids: z.array(id).min(1) }),
    },
    async (input) => {
      try {
        return ok(await store.resolveFeedback(input));
      } catch (e) {
        return fail(e);
      }
    },
  );
  return server;
}

const decisionBody = z.object({
  action: z.enum(['approve', 'approve_except', 'reject']),
  comment: z.string().default(''),
  by: z.string().min(1).default('architect'),
});

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
}

const MAX_BODY = 64 * 1024;

class TooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * The console's localhost API and page. Binds 127.0.0.1 only, and refuses requests a web page on
 * another origin could forge: a foreign Host (DNS rebinding), a foreign Origin, or a decision that
 * is not application/json (a "simple" request that skips the CORS preflight).
 */
export function createConsoleServer(store: GateStore, consoleHtmlPath: string, port: number): Server {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        if (!hosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden', message: 'unexpected Host' });
        if (req.method === 'POST') {
          const origin = req.headers.origin;
          if (origin !== undefined && !origins.has(origin)) return send(res, 403, { error: 'forbidden', message: 'cross-origin request' });
          if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            return send(res, 415, { error: 'unsupported', message: 'decisions must be application/json' });
          }
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/gate.html')) {
          return send(res, 200, readFileSync(consoleHtmlPath, 'utf8'), 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && url.pathname === '/api/gates') {
          const status = url.searchParams.get('status');
          if (status !== null && !['pending', 'approved', 'rejected'].includes(status)) return send(res, 400, { error: 'bad status' });
          return send(res, 200, await store.listGates((status as 'pending' | 'approved' | 'rejected' | null) ?? undefined));
        }
        const m = /^\/api\/gates\/([^/]+)\/decision$/.exec(url.pathname);
        if (req.method === 'POST' && m) {
          let raw: unknown;
          try {
            raw = await readJson(req);
          } catch (e) {
            if (e instanceof TooLarge) return send(res, 413, { error: 'too_large', message: `body over ${MAX_BODY} bytes` });
            raw = null;
          }
          const body = decisionBody.safeParse(raw);
          if (!body.success) return send(res, 400, { error: 'invalid', message: body.error.message });
          return send(res, 200, await store.decide(decodeURIComponent(m[1] as string), body.data));
        }
        return send(res, 404, { error: 'not_found' });
      } catch (e) {
        if (e instanceof GateError) {
          return send(res, { not_found: 404, conflict: 409, invalid: 400 }[e.code], { error: e.code, message: e.message });
        }
        return send(res, 500, { error: 'internal', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}
