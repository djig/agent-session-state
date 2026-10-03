import type { SessionEvent } from '../core/events';
import { isQuotaError, StorageQuotaError, type Snapshot, type StorageAdapter } from '../core/storage';

export interface LocalStorageOptions {
  /** Key prefix. Default `ass:` */
  prefix?: string;
  /**
   * Soft byte budget for one session's event log (UTF-16 code units × 2,
   * approximate). When exceeded, `appendEvents` throws `StorageQuotaError`
   * so the store compacts and retries. Default: 2 MB.
   */
  maxBytes?: number;
  /** Events per chunk key. Default 50. */
  chunkSize?: number;
  /** Injectable for tests / non-browser runtimes. Defaults to `globalThis.localStorage`. */
  storage?: Storage;
}

interface Meta {
  /** Chunk indices present, ascending. */
  chunks: number[];
  /** Approx bytes used by chunks. */
  bytes: number;
}

/**
 * localStorage adapter. Events are stored in chunked keys so a single large
 * log does not have to be re-serialised on every append:
 *
 *   {prefix}{sessionId}:snap        -> Snapshot
 *   {prefix}{sessionId}:meta        -> Meta
 *   {prefix}{sessionId}:ev:{n}      -> SessionEvent[]
 *
 * SSR-safe: when `localStorage` is unavailable every method is a no-op that
 * reads as empty.
 */
export function localStorageStorage(options: LocalStorageOptions = {}): StorageAdapter {
  const prefix = options.prefix ?? 'ass:';
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const chunkSize = options.chunkSize ?? 50;

  function ls(): Storage | null {
    if (options.storage) return options.storage;
    try {
      if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null;
      return window.localStorage;
    } catch {
      return null;
    }
  }

  const k = {
    snap: (id: string) => `${prefix}${id}:snap`,
    meta: (id: string) => `${prefix}${id}:meta`,
    chunk: (id: string, n: number) => `${prefix}${id}:ev:${n}`,
  };

  function readJson<T>(s: Storage, key: string): T | null {
    try {
      const raw = s.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  function writeJson(s: Storage, key: string, value: unknown): number {
    const raw = JSON.stringify(value);
    try {
      s.setItem(key, raw);
    } catch (e) {
      if (isQuotaError(e)) throw new StorageQuotaError('localStorage quota exceeded', e);
      throw e;
    }
    return raw.length * 2;
  }

  function readMeta(s: Storage, id: string): Meta {
    return readJson<Meta>(s, k.meta(id)) ?? { chunks: [], bytes: 0 };
  }

  function readAll(s: Storage, id: string): SessionEvent[] {
    const meta = readMeta(s, id);
    const out: SessionEvent[] = [];
    for (const n of meta.chunks) {
      const chunk = readJson<SessionEvent[]>(s, k.chunk(id, n));
      if (chunk) out.push(...chunk);
    }
    return out;
  }

  return {
    loadSnapshot(id) {
      const s = ls();
      return s ? readJson<Snapshot>(s, k.snap(id)) : null;
    },
    saveSnapshot(id, snap) {
      const s = ls();
      if (!s) return;
      writeJson(s, k.snap(id), snap);
    },
    appendEvents(id, events) {
      const s = ls();
      if (!s || events.length === 0) return;
      const meta = readMeta(s, id);
      if (meta.bytes > maxBytes) throw new StorageQuotaError(`event log over maxBytes (${maxBytes})`);
      const existing = new Set(readAll(s, id).map((e) => e.seq));
      const fresh = events.filter((e) => !existing.has(e.seq));
      if (fresh.length === 0) return;

      let lastN = meta.chunks.length ? meta.chunks[meta.chunks.length - 1]! : -1;
      let lastChunk = lastN >= 0 ? (readJson<SessionEvent[]>(s, k.chunk(id, lastN)) ?? []) : [];
      if (lastN < 0 || lastChunk.length >= chunkSize) {
        lastN += 1;
        lastChunk = [];
        meta.chunks.push(lastN);
      }
      let bytes = meta.bytes;
      for (const e of fresh) {
        if (lastChunk.length >= chunkSize) {
          bytes += writeJson(s, k.chunk(id, lastN), lastChunk);
          lastN += 1;
          lastChunk = [];
          meta.chunks.push(lastN);
        }
        lastChunk.push(e);
      }
      bytes += writeJson(s, k.chunk(id, lastN), lastChunk);
      meta.bytes = bytes;
      writeJson(s, k.meta(id), meta);
    },
    loadEventsAfter(id, seq) {
      const s = ls();
      if (!s) return [];
      return readAll(s, id)
        .filter((e) => e.seq > seq)
        .sort((a, b) => a.seq - b.seq);
    },
    trimEvents(id, upToSeq) {
      const s = ls();
      if (!s) return;
      const meta = readMeta(s, id);
      const keep: number[] = [];
      let bytes = 0;
      for (const n of meta.chunks) {
        const chunk = readJson<SessionEvent[]>(s, k.chunk(id, n)) ?? [];
        const rest = chunk.filter((e) => e.seq > upToSeq);
        if (rest.length === 0) {
          s.removeItem(k.chunk(id, n));
        } else {
          bytes += writeJson(s, k.chunk(id, n), rest);
          keep.push(n);
        }
      }
      writeJson(s, k.meta(id), { chunks: keep, bytes });
    },
    clear(id) {
      const s = ls();
      if (!s) return;
      const meta = readMeta(s, id);
      for (const n of meta.chunks) s.removeItem(k.chunk(id, n));
      s.removeItem(k.meta(id));
      s.removeItem(k.snap(id));
    },
    listSessions() {
      const s = ls();
      if (!s) return [];
      const ids = new Set<string>();
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key && key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const idx = rest.lastIndexOf(':snap');
          const idx2 = rest.lastIndexOf(':meta');
          if (idx > 0) ids.add(rest.slice(0, idx));
          else if (idx2 > 0) ids.add(rest.slice(0, idx2));
        }
      }
      return Array.from(ids);
    },
  };
}
