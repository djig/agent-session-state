import type { SessionEvent } from '../core/events';
import { isQuotaError, StorageQuotaError, type Snapshot, type StorageAdapter } from '../core/storage';

export interface IndexedDbOptions {
  /** Default `agent-session-state`. */
  dbName?: string;
  /** Injectable for tests (e.g. `fake-indexeddb`). Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

const EVENTS = 'events';
const SNAPSHOTS = 'snapshots';

/**
 * Raw IndexedDB adapter (no dependencies).
 *
 * Object stores:
 *   events    keyPath [sessionId, seq]
 *   snapshots keyPath sessionId
 *
 * SSR-safe: when `indexedDB` is unavailable every method resolves as empty.
 */
export function indexedDbStorage(options: IndexedDbOptions = {}): StorageAdapter {
  const dbName = options.dbName ?? 'agent-session-state';
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function factory(): IDBFactory | null {
    if (options.indexedDB) return options.indexedDB;
    try {
      return typeof indexedDB !== 'undefined' ? indexedDB : null;
    } catch {
      return null;
    }
  }

  function open(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    const f = factory();
    if (!f) return (dbPromise = Promise.resolve(null));
    dbPromise = new Promise((resolve, reject) => {
      const req = f.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(EVENTS)) {
          db.createObjectStore(EVENTS, { keyPath: ['sessionId', 'seq'] });
        }
        if (!db.objectStoreNames.contains(SNAPSHOTS)) {
          db.createObjectStore(SNAPSHOTS, { keyPath: 'sessionId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    });
    return dbPromise;
  }

  function wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  function mapErr(e: unknown): never {
    if (isQuotaError(e)) throw new StorageQuotaError('indexedDB quota exceeded', e);
    throw e;
  }

  return {
    async loadSnapshot(id) {
      const db = await open();
      if (!db) return null;
      const tx = db.transaction(SNAPSHOTS, 'readonly');
      const row = (await wrap(tx.objectStore(SNAPSHOTS).get(id))) as { snapshot: Snapshot } | undefined;
      return row?.snapshot ?? null;
    },
    async saveSnapshot(id, snapshot) {
      const db = await open();
      if (!db) return;
      try {
        const tx = db.transaction(SNAPSHOTS, 'readwrite');
        tx.objectStore(SNAPSHOTS).put({ sessionId: id, snapshot });
        await done(tx);
      } catch (e) {
        mapErr(e);
      }
    },
    async appendEvents(id, events) {
      const db = await open();
      if (!db || events.length === 0) return;
      try {
        const tx = db.transaction(EVENTS, 'readwrite');
        const store = tx.objectStore(EVENTS);
        for (const e of events) store.put({ sessionId: id, seq: e.seq, event: e });
        await done(tx);
      } catch (e) {
        mapErr(e);
      }
    },
    async loadEventsAfter(id, seq) {
      const db = await open();
      if (!db) return [];
      const tx = db.transaction(EVENTS, 'readonly');
      const range = IDBKeyRange.bound([id, seq], [id, Infinity], true, false);
      const rows = (await wrap(tx.objectStore(EVENTS).getAll(range))) as Array<{ event: SessionEvent }>;
      return rows.map((r) => r.event).sort((a, b) => a.seq - b.seq);
    },
    async trimEvents(id, upToSeq) {
      const db = await open();
      if (!db) return;
      const tx = db.transaction(EVENTS, 'readwrite');
      tx.objectStore(EVENTS).delete(IDBKeyRange.bound([id, -Infinity], [id, upToSeq], false, false));
      await done(tx);
    },
    async clear(id) {
      const db = await open();
      if (!db) return;
      const tx = db.transaction([EVENTS, SNAPSHOTS], 'readwrite');
      tx.objectStore(EVENTS).delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
      tx.objectStore(SNAPSHOTS).delete(id);
      await done(tx);
    },
    async listSessions() {
      const db = await open();
      if (!db) return [];
      const tx = db.transaction([EVENTS, SNAPSHOTS], 'readonly');
      const ids = new Set<string>();
      const snaps = (await wrap(tx.objectStore(SNAPSHOTS).getAllKeys())) as string[];
      snaps.forEach((s) => ids.add(s));
      const evKeys = (await wrap(tx.objectStore(EVENTS).getAllKeys())) as Array<[string, number]>;
      evKeys.forEach((k) => ids.add(k[0]));
      return Array.from(ids);
    },
  };
}
