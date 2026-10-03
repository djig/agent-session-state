import type { SessionEvent } from '../core/events';
import type { Snapshot, StorageAdapter } from '../core/storage';

export interface HttpStorageOptions {
  /** e.g. `/api/agent-sessions` — the handler mounts `/sessions/:id/...` under it. */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}

/**
 * Thin HTTP client for a remote event log. Wire contract (JSON everywhere):
 *
 *   GET  {baseUrl}/sessions/:id/snapshot          -> Snapshot | 204/404 when none
 *   PUT  {baseUrl}/sessions/:id/snapshot          <- Snapshot
 *   GET  {baseUrl}/sessions/:id/events?after=N    -> SessionEvent[] (seq > N, ascending)
 *   POST {baseUrl}/sessions/:id/events            <- SessionEvent[]  (idempotent on seq)
 *   DELETE {baseUrl}/sessions/:id/events?upTo=N   (optional; trims events with seq <= N)
 *   DELETE {baseUrl}/sessions/:id                 (optional; wipes the session)
 *   GET  {baseUrl}/sessions                       -> string[] (optional)
 *
 * `createHttpStorageHandler()` from `@djignesh21/agent-session-state/server` implements
 * this contract on top of any StorageAdapter using Web Request/Response.
 */
export function httpStorage(options: HttpStorageOptions): StorageAdapter {
  const base = options.baseUrl.replace(/\/+$/, '');
  const f = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function headers(json: boolean): Promise<Record<string, string>> {
    const h = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
    return json ? { 'content-type': 'application/json', ...h } : { ...h };
  }

  async function ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`httpStorage: ${what} failed with ${res.status}`);
    return res;
  }

  return {
    async loadSnapshot(id) {
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}/snapshot`, { headers: await headers(false) });
      if (res.status === 204 || res.status === 404) return null;
      await ok(res, 'GET snapshot');
      const text = await res.text();
      return text ? (JSON.parse(text) as Snapshot) : null;
    },
    async saveSnapshot(id, snapshot) {
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}/snapshot`, {
        method: 'PUT',
        headers: await headers(true),
        body: JSON.stringify(snapshot),
      });
      await ok(res, 'PUT snapshot');
    },
    async appendEvents(id, events) {
      if (!events.length) return;
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify(events),
      });
      await ok(res, 'POST events');
    },
    async loadEventsAfter(id, seq) {
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}/events?after=${seq}`, {
        headers: await headers(false),
      });
      await ok(res, 'GET events');
      return (await res.json()) as SessionEvent[];
    },
    async trimEvents(id, upToSeq) {
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}/events?upTo=${upToSeq}`, {
        method: 'DELETE',
        headers: await headers(false),
      });
      if (res.status === 404 || res.status === 405) return; // server does not support trimming
      await ok(res, 'DELETE events');
    },
    async clear(id) {
      const res = await f(`${base}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await headers(false) });
      if (res.status === 404 || res.status === 405) return;
      await ok(res, 'DELETE session');
    },
    async listSessions() {
      const res = await f(`${base}/sessions`, { headers: await headers(false) });
      await ok(res, 'GET sessions');
      return (await res.json()) as string[];
    },
  };
}
