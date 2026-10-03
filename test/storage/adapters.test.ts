import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createSessionStore, memoryStorage, type SessionEvent, type StorageAdapter } from '../../src';
import { indexedDbStorage } from '../../src/storage/indexeddb';
import { httpStorage } from '../../src/storage/http';
import { createHttpStorageHandler } from '../../src/server';

function ev(seq: number, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { type: 'CUSTOM', name: 'n', value: seq, seq, ts: seq, ...extra } as SessionEvent;
}

/** Contract tests every adapter must satisfy. */
function contract(name: string, make: () => StorageAdapter) {
  describe(`storage contract: ${name}`, () => {
    it('starts empty', async () => {
      const s = make();
      expect(await s.loadSnapshot('x')).toBeNull();
      expect(await s.loadEventsAfter('x', 0)).toEqual([]);
    });

    it('appends, reads after seq, dedupes by seq, isolates sessions', async () => {
      const s = make();
      await s.appendEvents('a', [ev(1), ev(2)]);
      await s.appendEvents('a', [ev(2), ev(3)]);
      await s.appendEvents('b', [ev(1)]);
      expect((await s.loadEventsAfter('a', 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect((await s.loadEventsAfter('a', 2)).map((e) => e.seq)).toEqual([3]);
      expect((await s.loadEventsAfter('b', 0)).map((e) => e.seq)).toEqual([1]);
    });

    it('saves and loads snapshots; trims; clears; lists', async () => {
      const s = make();
      const state = createSessionStore({ sessionId: 'a', storage: memoryStorage() }).getState();
      await s.appendEvents('a', [ev(1), ev(2), ev(3)]);
      await s.saveSnapshot('a', { state: { ...state, cursor: { lastSeq: 2 } }, lastSeq: 2 });
      expect((await s.loadSnapshot('a'))?.lastSeq).toBe(2);
      if (s.trimEvents) {
        await s.trimEvents('a', 2);
        expect((await s.loadEventsAfter('a', 0)).map((e) => e.seq)).toEqual([3]);
      }
      if (s.listSessions) expect(await s.listSessions()).toEqual(['a']);
      await s.clear('a');
      expect(await s.loadSnapshot('a')).toBeNull();
      expect(await s.loadEventsAfter('a', 0)).toEqual([]);
    });

    it('round-trips through a store', async () => {
      const storage = make();
      const a = createSessionStore({ sessionId: 'rt', storage });
      a.append([
        { type: 'RUN_STARTED', runId: 'r' },
        { type: 'APPROVAL_REQUESTED', approvalId: 'ap', kind: 'tool', title: 'ok?' },
      ]);
      await a.flush();
      await a.compact();
      a.append({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'tail' });
      await a.flush();
      const b = createSessionStore({ sessionId: 'rt', storage });
      expect(await b.hydrate()).toEqual(a.getState());
    });
  });
}

contract('memory', () => memoryStorage());

contract('indexedDB (fake-indexeddb)', () => indexedDbStorage({ dbName: `t-${Math.random()}`, indexedDB: new IDBFactory() }));

// http client ↔ reference handler, in-process.
function makeHttp(): StorageAdapter {
  const handler = createHttpStorageHandler(memoryStorage());
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(new Request(new URL(url, 'http://test.local'), init));
  };
  return httpStorage({ baseUrl: '/api/agent', fetch: fetchImpl });
}
contract('http (client ↔ reference handler)', makeHttp);

describe('indexedDbStorage: SSR guard', () => {
  it('is a no-op when indexedDB is unavailable', async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error deliberately removing
    delete globalThis.indexedDB;
    try {
      const s = indexedDbStorage({ dbName: 'nope' });
      expect(await s.loadSnapshot('x')).toBeNull();
      expect(await s.loadEventsAfter('x', 0)).toEqual([]);
      await s.appendEvents('x', [ev(1)]);
      await s.saveSnapshot('x', { state: createSessionStore({ sessionId: 'x', storage: memoryStorage() }).getState(), lastSeq: 0 });
    } finally {
      globalThis.indexedDB = saved;
    }
  });
});

describe('createHttpStorageHandler', () => {
  const handler = createHttpStorageHandler(memoryStorage(), {
    authorize: (req) => (req.headers.get('authorization') === 'Bearer ok' ? undefined : new Response('nope', { status: 401 })),
  });
  const call = (method: string, path: string, body?: unknown, auth = 'Bearer ok') =>
    handler(
      new Request(`http://x${path}`, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it('enforces authorize()', async () => {
    expect((await call('GET', '/api/sessions/a/snapshot', undefined, 'nope')).status).toBe(401);
  });

  it('validates bodies and methods', async () => {
    expect((await call('POST', '/api/sessions/a/events', { not: 'array' })).status).toBe(400);
    expect((await call('POST', '/api/sessions/a/events', [{ type: 'X' }])).status).toBe(400);
    expect((await call('PUT', '/api/sessions/a/snapshot', { bogus: true })).status).toBe(400);
    expect((await call('PATCH', '/api/sessions/a/snapshot')).status).toBe(405);
    expect((await call('GET', '/api/other')).status).toBe(404);
    expect((await call('GET', '/api/sessions/a/unknown')).status).toBe(404);
    expect((await call('DELETE', '/api/sessions/a/events')).status).toBe(400);
  });

  it('serves the happy path', async () => {
    expect((await call('GET', '/api/sessions/a/snapshot')).status).toBe(204);
    expect((await call('POST', '/api/sessions/a/events', [ev(1), ev(2)])).status).toBe(204);
    const list = await (await call('GET', '/api/sessions/a/events?after=1')).json();
    expect(list.map((e: SessionEvent) => e.seq)).toEqual([2]);
    expect(await (await call('GET', '/api/sessions')).json()).toEqual(['a']);
    expect((await call('DELETE', '/api/sessions/a/events?upTo=2')).status).toBe(204);
    expect(await (await call('GET', '/api/sessions/a/events?after=0')).json()).toEqual([]);
    expect((await call('DELETE', '/api/sessions/a')).status).toBe(204);
  });

  it('httpStorage surfaces server errors', async () => {
    const s = httpStorage({ baseUrl: 'http://x', fetch: async () => new Response('boom', { status: 500 }) });
    await expect(s.loadEventsAfter('a', 0)).rejects.toThrow(/500/);
  });
});
