import type { SessionEvent } from './events';
import type { SessionState } from './state';

export interface Snapshot {
  state: SessionState;
  /** seq of the last event folded into `state`. */
  lastSeq: number;
  savedAt?: number;
}

/**
 * Pluggable persistence. All methods may be sync or async; the store awaits them.
 *
 * Contract:
 * - `appendEvents` must store events durably in `seq` order and be idempotent
 *   for an event whose `seq` already exists (the store may re-send after a
 *   failed write).
 * - `loadEventsAfter(id, seq)` returns events with `seq > seq`, ascending.
 * - `saveSnapshot` replaces any previous snapshot. Implementations MAY drop
 *   events with `seq <= lastSeq` afterwards (the store calls `compact()` for this).
 */
export interface StorageAdapter {
  loadSnapshot(sessionId: string): Promise<Snapshot | null> | Snapshot | null;
  saveSnapshot(sessionId: string, snapshot: Snapshot): Promise<void> | void;
  appendEvents(sessionId: string, events: SessionEvent[]): Promise<void> | void;
  loadEventsAfter(sessionId: string, seq: number): Promise<SessionEvent[]> | SessionEvent[];
  /** Remove events with `seq <= upToSeq` (after a snapshot covers them). Optional. */
  trimEvents?(sessionId: string, upToSeq: number): Promise<void> | void;
  clear(sessionId: string): Promise<void> | void;
  listSessions?(): Promise<string[]> | string[];
}

/** Thrown by adapters when the backing store refuses a write for capacity reasons. */
export class StorageQuotaError extends Error {
  constructor(
    message = 'storage quota exceeded',
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export function isQuotaError(e: unknown): boolean {
  if (e instanceof StorageQuotaError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: string; code?: number; message?: string };
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014 ||
    /quota/i.test(err.message ?? '')
  );
}

/** In-memory adapter. Useful for tests, SSR, and as a reference implementation. */
export function memoryStorage(): StorageAdapter & {
  /** Test helper: peek at stored data. */
  _dump(): { snapshots: Record<string, Snapshot>; events: Record<string, SessionEvent[]> };
} {
  const snapshots: Record<string, Snapshot> = {};
  const events: Record<string, SessionEvent[]> = {};
  return {
    loadSnapshot(id) {
      const s = snapshots[id];
      return s ? structuredClone(s) : null;
    },
    saveSnapshot(id, snap) {
      snapshots[id] = structuredClone(snap);
    },
    appendEvents(id, evs) {
      const list = (events[id] ??= []);
      for (const e of evs) {
        if (list.some((x) => x.seq === e.seq)) continue;
        list.push(structuredClone(e));
      }
      list.sort((a, b) => a.seq - b.seq);
    },
    loadEventsAfter(id, seq) {
      return (events[id] ?? []).filter((e) => e.seq > seq).map((e) => structuredClone(e));
    },
    trimEvents(id, upToSeq) {
      events[id] = (events[id] ?? []).filter((e) => e.seq > upToSeq);
    },
    clear(id) {
      delete snapshots[id];
      delete events[id];
    },
    listSessions() {
      return Array.from(new Set([...Object.keys(snapshots), ...Object.keys(events)]));
    },
    _dump() {
      return { snapshots, events };
    },
  };
}
