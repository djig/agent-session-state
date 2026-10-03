import type { SessionEvent } from '../core/events';
import type { Snapshot, StorageAdapter } from '../core/storage';

export interface HttpStorageHandlerOptions {
  /**
   * Path prefix to strip before matching `/sessions/...`. Default: auto-detect
   * (everything up to and including the last `/sessions` segment).
   */
  basePath?: string;
  /** Hook to authorise a request; return a Response to short-circuit (e.g. 401). */
  authorize?: (req: Request, sessionId: string | null) => Promise<Response | void> | Response | void;
}

/**
 * Reference HTTP handler implementing the `httpStorage` wire contract on top of
 * any `StorageAdapter`, using Web `Request`/`Response`. Drops straight into a
 * Next.js route handler, Hono, Bun, Deno, or Node 18+ via `@whatwg-node/server`.
 *
 * ```ts
 * // app/api/agent-sessions/[...path]/route.ts
 * const handler = createHttpStorageHandler(myStorage);
 * export const GET = handler; export const POST = handler;
 * export const PUT = handler; export const DELETE = handler;
 * ```
 */
export function createHttpStorageHandler(
  storage: StorageAdapter,
  options: HttpStorageHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function route(url: URL): { sessionId: string | null; rest: string[] } | null {
    let path = url.pathname;
    if (options.basePath) {
      if (!path.startsWith(options.basePath)) return null;
      path = path.slice(options.basePath.length);
    }
    const parts = path.split('/').filter(Boolean);
    const i = parts.lastIndexOf('sessions');
    if (i < 0) return null;
    const after = parts.slice(i + 1);
    if (after.length === 0) return { sessionId: null, rest: [] };
    return { sessionId: decodeURIComponent(after[0]!), rest: after.slice(1) };
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const r = route(url);
    if (!r) return json({ error: 'not found' }, 404);
    const { sessionId, rest } = r;

    if (options.authorize) {
      const deny = await options.authorize(req, sessionId);
      if (deny) return deny;
    }

    try {
      // GET /sessions
      if (sessionId === null) {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const ids = storage.listSessions ? await storage.listSessions() : [];
        return json(ids);
      }

      const sub = rest[0];

      if (sub === undefined) {
        if (req.method === 'DELETE') {
          await storage.clear(sessionId);
          return new Response(null, { status: 204 });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      if (sub === 'snapshot') {
        if (req.method === 'GET') {
          const snap = await storage.loadSnapshot(sessionId);
          return snap ? json(snap) : new Response(null, { status: 204 });
        }
        if (req.method === 'PUT') {
          const body = (await req.json()) as Snapshot;
          if (!body || typeof body.lastSeq !== 'number' || !body.state) return json({ error: 'invalid snapshot' }, 400);
          await storage.saveSnapshot(sessionId, body);
          return new Response(null, { status: 204 });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      if (sub === 'events') {
        if (req.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? '0');
          const events = await storage.loadEventsAfter(sessionId, Number.isFinite(after) ? after : 0);
          return json(events);
        }
        if (req.method === 'POST') {
          const body = (await req.json()) as unknown;
          if (!Array.isArray(body)) return json({ error: 'expected an array of events' }, 400);
          for (const e of body as SessionEvent[]) {
            if (typeof e !== 'object' || e === null || typeof e.type !== 'string' || typeof e.seq !== 'number') {
              return json({ error: 'invalid event' }, 400);
            }
          }
          await storage.appendEvents(sessionId, body as SessionEvent[]);
          return new Response(null, { status: 204 });
        }
        if (req.method === 'DELETE') {
          const upToRaw = url.searchParams.get('upTo');
          const upTo = Number(upToRaw);
          if (upToRaw === null || !Number.isFinite(upTo)) return json({ error: 'upTo required' }, 400);
          if (!storage.trimEvents) return json({ error: 'trim not supported' }, 405);
          await storage.trimEvents(sessionId, upTo);
          return new Response(null, { status: 204 });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message ?? 'internal error' }, 500);
    }
  };
}
