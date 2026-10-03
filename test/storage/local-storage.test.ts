// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmitter, createSessionStore, StorageQuotaError, type SessionEvent } from '../../src';
import { localStorageStorage } from '../../src/storage/local-storage';

function ev(seq: number): SessionEvent {
  return { type: 'CUSTOM', name: 'n', value: seq, seq, ts: seq };
}

/** A Storage wrapper whose setItem throws a QuotaExceededError while `failures > 0`. */
function flaky(base: Storage, shouldFail: (key: string) => boolean) {
  const ctl = { failures: 0 };
  const storage: Storage = {
    get length() {
      return base.length;
    },
    key: (i) => base.key(i),
    getItem: (k) => base.getItem(k),
    removeItem: (k) => base.removeItem(k),
    clear: () => base.clear(),
    setItem(k, v) {
      if (ctl.failures > 0 && shouldFail(k)) {
        ctl.failures--;
        throw new DOMException('full', 'QuotaExceededError');
      }
      base.setItem(k, v);
    },
  };
  return { storage, ctl };
}

describe('localStorageStorage', () => {
  beforeEach(() => localStorage.clear());

  it('chunks events across keys and reads them back in order', () => {
    const s = localStorageStorage({ prefix: 't:', chunkSize: 2 });
    s.appendEvents('a', [ev(1), ev(2), ev(3)]);
    s.appendEvents('a', [ev(3), ev(4), ev(5)]); // dedupe seq 3
    expect(localStorage.getItem('t:a:ev:0')).toBeTruthy();
    expect(localStorage.getItem('t:a:ev:1')).toBeTruthy();
    expect(localStorage.getItem('t:a:ev:2')).toBeTruthy();
    expect(localStorage.getItem('t:a:ev:3')).toBeNull();
    expect((s.loadEventsAfter('a', 0) as SessionEvent[]).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((s.loadEventsAfter('a', 3) as SessionEvent[]).map((e) => e.seq)).toEqual([4, 5]);
  });

  it('snapshots, trims, lists and clears', () => {
    const s = localStorageStorage({ prefix: 't:', chunkSize: 2 });
    const state = createSessionStore({ sessionId: 'a', storage: s }).getState();
    s.appendEvents('a', [ev(1), ev(2), ev(3), ev(4)]);
    s.saveSnapshot('a', { state, lastSeq: 3 });
    expect((s.loadSnapshot('a') as { lastSeq: number }).lastSeq).toBe(3);
    s.trimEvents!('a', 3);
    expect(localStorage.getItem('t:a:ev:0')).toBeNull();
    expect((s.loadEventsAfter('a', 0) as SessionEvent[]).map((e) => e.seq)).toEqual([4]);
    expect(s.listSessions!()).toEqual(['a']);
    s.clear('a');
    expect(Object.keys(localStorage).filter((k) => k.startsWith('t:'))).toEqual([]);
  });

  it('is SSR-safe: injected null-ish storage reads as empty', () => {
    const s = localStorageStorage({ storage: undefined as unknown as Storage, prefix: 'ssr:' });
    const win = globalThis.window;
    // Simulate "no window".
    // @ts-expect-error deliberately removing
    delete globalThis.window;
    try {
      expect(s.loadSnapshot('x')).toBeNull();
      expect(s.loadEventsAfter('x', 0)).toEqual([]);
      s.appendEvents('x', [ev(1)]);
    } finally {
      globalThis.window = win;
    }
  });

  it('throws StorageQuotaError when the log exceeds maxBytes', () => {
    const s = localStorageStorage({ prefix: 't:', maxBytes: 50 });
    s.appendEvents('a', [ev(1), ev(2)]);
    expect(() => s.appendEvents('a', [ev(3)])).toThrow(StorageQuotaError);
  });

  it('maps a native QuotaExceededError from setItem to StorageQuotaError', () => {
    const { storage, ctl } = flaky(localStorage, () => true);
    const s = localStorageStorage({ prefix: 't:', storage });
    ctl.failures = 1;
    expect(() => s.appendEvents('a', [ev(1)])).toThrow(StorageQuotaError);
    s.appendEvents('a', [ev(1)]);
    expect((s.loadEventsAfter('a', 0) as SessionEvent[]).map((e) => e.seq)).toEqual([1]);
  });

  it('store on quota: compacts and retries, then degrades gracefully', async () => {
    const { storage: raw, ctl } = flaky(localStorage, (k) => k.includes(':ev:'));
    const storage = localStorageStorage({ prefix: 't:', chunkSize: 2, storage: raw });
    const onError = vi.fn();
    const store = createSessionStore({ sessionId: 's', storage, onError });
    const emit = createEmitter(store);
    emit.startRun({ runId: 'r' });
    await store.flush();

    // Fail the next chunk write once → store compacts (snapshot + trim) and retries.
    ctl.failures = 1;
    emit.requestApproval({ approvalId: 'ap', title: 'ok?' });
    await store.flush();
    expect(store.degraded).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('t:s:snap')!).lastSeq).toBe(1);

    // Persistent failure → degraded, but the in-memory state still advances.
    ctl.failures = 99;
    emit.text('m', 'hello');
    await store.flush();
    expect(store.degraded).toBe(true);
    expect(onError).toHaveBeenCalled();
    expect(store.getState().messages[0]!.content).toBe('hello');
    ctl.failures = 0;

    // Reload: the approval (persisted before the outage) is still there.
    const again = createSessionStore({ sessionId: 's', storage });
    expect((await again.hydrate()).pendingApprovals.map((a) => a.approvalId)).toEqual(['ap']);
  });
});
