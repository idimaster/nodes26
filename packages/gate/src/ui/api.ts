import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { gdsAvailable } from '@planner/graph-mcp';
import { tableProviders, validatorWitness, type TableProvider, type WitnessProvider } from './providers.js';
import { readQuery, toNum } from './read.js';
import { loadScene, toResponse } from './scenes.js';

/** Read-only UI endpoints (T4.2 addendum, Step 3) and the built page from viz/dist. */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
};

export interface UiContext {
  driver: Driver;
  vizDist: string;
  witness?: WitnessProvider;
  tables?: TableProvider[];
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const iterationParam = (url: URL) => {
  const n = Number(url.searchParams.get('iteration'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Returns true when it handled the request. */
export function uiHandler(ctx: UiContext) {
  const witness = ctx.witness ?? validatorWitness(ctx.driver);
  const tables = new Map((ctx.tables ?? tableProviders(ctx.driver)).map((t) => [t.name, t]));
  const dist = resolve(ctx.vizDist);

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'GET') return false;
    const deal = url.searchParams.get('deal') ?? '';

    if (url.pathname === '/api/health') {
      let neo4jUp = false;
      let gds = false;
      try {
        await readQuery(ctx.driver, 'RETURN 1 AS ok');
        neo4jUp = true;
        gds = await gdsAvailable(ctx.driver);
      } catch {
        // reported as false below
      }
      json(res, 200, {
        ok: neo4jUp,
        neo4j: neo4jUp,
        gds,
        providers: { witness: 'validators', tables: Object.fromEntries([...tables.keys()].map((k) => [k, 'available'])) },
      });
      return true;
    }

    if (url.pathname === '/api/iterations') {
      if (!deal) return (json(res, 400, { error: 'deal is required' }), true);
      const rows = await readQuery(
        ctx.driver,
        'MATCH (i:Iteration {deal_code: $deal}) RETURN i.n AS n, i.status AS status, toString(i.started_at) AS started_at ORDER BY n DESC',
        { deal },
      );
      json(res, 200, rows.map((r) => ({ n: toNum(r.get('n')), status: r.get('status'), started_at: r.get('started_at') })));
      return true;
    }

    if (url.pathname === '/api/graph') {
      const iteration = iterationParam(url);
      const scene = Number(url.searchParams.get('scene') ?? '2');
      if (!deal || iteration === null || ![1, 2, 3].includes(scene)) return (json(res, 400, { error: 'deal, iteration, and scene (1-3) are required' }), true);
      const data = await loadScene(ctx.driver, deal, iteration, scene as 1 | 2 | 3);
      json(res, 200, toResponse(data, await witness.latest(deal, iteration, data.version)));
      return true;
    }

    const t = /^\/api\/tables\/([a-z_]+)$/.exec(url.pathname);
    if (t) {
      const provider = tables.get(t[1] as never);
      const iteration = iterationParam(url);
      if (!provider) return (json(res, 404, { error: 'unknown table' }), true);
      if (!deal || iteration === null) return (json(res, 400, { error: 'deal and iteration are required' }), true);
      try {
        json(res, 200, await provider.get(deal, iteration));
      } catch (e) {
        json(res, 200, { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // Static page (viz/dist). Paths outside dist are refused.
    if (!url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
      const file = resolve(join(dist, rel));
      if (!file.startsWith(dist + sep)) return (json(res, 404, { error: 'not_found' }), true);
      if (!existsSync(join(dist, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('The demo UI is not built. Run: npm run demo:ui\n');
        return true;
      }
      if (!existsSync(file) || !statSync(file).isFile()) return false;
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
      return true;
    }
    return false;
  };
}
