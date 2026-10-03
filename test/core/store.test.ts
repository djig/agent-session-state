import { describe, expect, it, vi } from 'vitest';
import {
  computeCost,
  createEmitter,
  createSessionStore,
  memoryStorage,
  StorageQuotaError,
  type SessionEvent,
  type StorageAdapter,
} from '../../src';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('store: append & subscribe', () => {
  it('assigns monotonically increasing seq and ts from the clock', async () => {
    let now = 100;
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage(), clock: () => now++ });
    const [a] = store.append({ type: 'RUN_STARTED', runId: 'r' });
    const [b, c] = store.append([
      { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' },
    ]);
    expect([a!.seq, b!.seq, c!.seq]).toEqual([1, 2, 3]);
    expect([a!.ts, b!.ts, c!.ts]).toEqual([100, 101, 102]);
    expect(b!.runId).toBe('r'); // runId filled from current run
    expect(store.getState().messages[0]!.content).toBe('hi');
    await store.flush();
  });

  it('notifies subscribers once per append call', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.append([{ type: 'RUN_STARTED', runId: 'r' }, { type: 'RUN_FINISHED', runId: 'r' }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].status).toBe('finished');
    unsub();
    store.append({ type: 'RUN_STARTED', runId: 'r2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('computes USAGE cost from pricing when not supplied', async () => {
    const store = createSessionStore({
      sessionId: 's',
      storage: memoryStorage(),
      pricing: { 'model-x': { inputPerMTok: 1, outputPerMTok: 4, cachedInputPerMTok: 0.1 } },
    });
    store.append({ type: 'USAGE', model: 'model-x', inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 500_000 });
    store.append({ type: 'USAGE', model: 'unknown', inputTokens: 10, outputTokens: 10 });
    store.append({ type: 'USAGE', model: 'model-x', inputTokens: 10, outputTokens: 10, costUsd: 7 });
    // 500k uncached * $1 + 500k cached * $0.1 + 500k out * $4 = 0.5 + 0.05 + 2 = 2.55
    expect(store.getState().usage.byModel['model-x']!.costUsd).toBe(9.55);
    expect(store.getState().usage.totals.costUsd).toBe(9.55);
    expect(computeCost(undefined, { model: 'a', inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    await store.flush();
  });
});

describe('store: hydrate', () => {
  it('rebuilds state from snapshot + tail', async () => {
    const storage = memoryStorage();
    await storage.saveSnapshot('s', {
      state: {
        ...createSessionStore({ sessionId: 's', storage: memoryStorage() }).getState(),
        messages: [{ id: 'm', role: 'assistant', content: 'from-snap', parts: [], createdAt: 1, complete: false }],
        cursor: { lastSeq: 5 },
      },
      lastSeq: 5,
    });
    await storage.appendEvents('s', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '+tail', seq: 6, ts: 6 },
      { type: 'TEXT_MESSAGE_END', messageId: 'm', seq: 7, ts: 7 },
    ] as SessionEvent[]);
    const store = createSessionStore({ sessionId: 's', storage });
    expect(store.hydrated).toBe(false);
    const state = await store.hydrate();
    expect(store.hydrated).toBe(true);
    expect(state.messages[0]).toMatchObject({ content: 'from-snap+tail', complete: true });
    expect(state.cursor.lastSeq).toBe(7);
    // Subsequent appends continue the sequence.
    const [e] = store.append({ type: 'RUN_STARTED', runId: 'r' });
    expect(e!.seq).toBe(8);
    await store.flush();
    expect((await storage.loadEventsAfter('s', 7)).map((x) => x.seq)).toEqual([8]);
  });

  it('is idempotent', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const [a, b] = await Promise.all([store.hydrate(), store.hydrate()]);
    expect(a).toBe(b);
  });

  it('rebases events appended before hydration finished', async () => {
    const storage = memoryStorage();
    await storage.appendEvents('s', [{ type: 'RUN_STARTED', runId: 'old', seq: 1, ts: 1 }] as SessionEvent[]);
    const store = createSessionStore({ sessionId: 's', storage });
    store.append({ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'user' }); // optimistic, seq 1 locally
    expect(store.getState().messages).toHaveLength(1);
    await store.hydrate();
    await store.flush();
    const s = store.getState();
    expect(s.runs.old).toBeDefined();
    expect(s.messages).toHaveLength(1);
    expect(s.cursor.lastSeq).toBe(2);
    const persisted = await storage.loadEventsAfter('s', 0);
    expect(persisted.map((e) => [e.seq, e.type])).toEqual([
      [1, 'RUN_STARTED'],
      [2, 'TEXT_MESSAGE_START'],
    ]);
  });

  it('survives a storage that throws on load', async () => {
    const onError = vi.fn();
    const bad: StorageAdapter = {
      ...memoryStorage(),
      loadSnapshot: () => {
        throw new Error('disk on fire');
      },
    };
    const store = createSessionStore({ sessionId: 's', storage: bad, onError });
    const s = await store.hydrate();
    expect(s.status).toBe('idle');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { op: 'hydrate' });
  });
});

describe('store: approvals survive reload', () => {
  it('pending approval requested in store A is present after hydrating store B', async () => {
    const storage = memoryStorage();
    const a = createSessionStore({ sessionId: 'chat-1', storage });
    const emit = createEmitter(a);
    emit.startRun({ runId: 'r1' });
    emit.toolCall({ toolCallId: 't1', name: 'send_email', args: { to: 'x@y.z' } });
    emit.requestApproval({ approvalId: 'ap1', toolCallId: 't1', title: 'Send email?' });
    expect(a.getState().status).toBe('awaiting_approval');
    await a.flush();

    // "reload"
    const b = createSessionStore({ sessionId: 'chat-1', storage });
    const s = await b.hydrate();
    expect(s.status).toBe('awaiting_approval');
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]).toMatchObject({ approvalId: 'ap1', toolCallId: 't1', title: 'Send email?', runId: 'r1' });
    expect(s.toolCalls.t1!.args).toEqual({ to: 'x@y.z' });
    expect(b.getResumeCursor()).toEqual({ lastSeq: 5, runId: 'r1' });
  });
});

describe('store: outbox', () => {
  it('resolving offline leaves an undelivered resolution that a new store can deliver', async () => {
    const storage = memoryStorage();
    const a = createSessionStore({ sessionId: 's', storage });
    createEmitter(a).requestApproval({ approvalId: 'ap', title: 'ok?' });
    const resolution = a.resolveApproval('ap', 'approve', { note: 'go' });
    expect(resolution).toMatchObject({ approvalId: 'ap', decision: 'approve', resolvedBy: 'user' });
    expect(a.getState().outbox).toHaveLength(1);
    expect(a.getState().pendingApprovals).toHaveLength(0);
    await a.flush();

    const delivered: string[] = [];
    const b = createSessionStore({
      sessionId: 's',
      storage,
      onDeliver: async (r) => {
        delivered.push(r.approvalId);
      },
    });
    const s = await b.hydrate();
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({ approvalId: 'ap', payload: { note: 'go' } });
    await b.deliverOutbox();
    expect(delivered).toEqual(['ap']);
    expect(b.getState().outbox).toHaveLength(0);
    await b.flush();

    const c = createSessionStore({ sessionId: 's', storage });
    expect((await c.hydrate()).outbox).toHaveLength(0);
  });

  it('markDelivered clears the outbox; onDeliver success marks automatically; failure keeps it', async () => {
    const onError = vi.fn();
    let fail = true;
    const store = createSessionStore({
      sessionId: 's',
      storage: memoryStorage(),
      onError,
      onDeliver: async () => {
        if (fail) throw new Error('offline');
      },
    });
    const emit = createEmitter(store);
    emit.requestApproval({ approvalId: 'a1', title: 'a' });
    emit.requestApproval({ approvalId: 'a2', title: 'b' });
    store.resolveApproval('a1', 'reject');
    await tick();
    expect(store.getState().outbox.map((r) => r.approvalId)).toEqual(['a1']);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { op: 'deliver', approvalId: 'a1' });
    fail = false;
    store.resolveApproval('a2', 'approve');
    await tick();
    expect(store.getState().outbox.map((r) => r.approvalId)).toEqual(['a1']);
    store.markDelivered('a1');
    expect(store.getState().outbox).toHaveLength(0);
    store.markDelivered('a1'); // no-op
    expect(store.resolveApproval('ghost', 'approve')).toBeNull();
    await store.flush();
  });
});

describe('store: compaction', () => {
  it('compact() writes a snapshot, trims the log, and hydration yields equal state', async () => {
    const storage = memoryStorage();
    const a = createSessionStore({ sessionId: 's', storage, clock: () => 42 });
    const emit = createEmitter(a);
    emit.startRun({ runId: 'r' });
    emit.text('m', 'hello ');
    emit.text('m', 'world');
    emit.subagentStarted({ subagentId: 'sub', name: 'x' });
    emit.usage({ model: 'm', inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
    await a.flush();
    expect(storage._dump().events.s).toHaveLength(6);
    await a.compact();
    expect(storage._dump().events.s).toHaveLength(0);
    expect(storage._dump().snapshots.s!.lastSeq).toBe(6);
    emit.finishRun('r');
    await a.flush();
    expect(storage._dump().events.s).toHaveLength(1);

    const b = createSessionStore({ sessionId: 's', storage });
    expect(await b.hydrate()).toEqual(a.getState());
  });

  it('auto-compacts every `snapshotEvery` events', async () => {
    const storage = memoryStorage();
    const store = createSessionStore({ sessionId: 's', storage, snapshotEvery: 3 });
    await store.hydrate();
    for (let i = 0; i < 7; i++) {
      store.append({ type: 'CUSTOM', name: 'n', value: i });
      await store.flush();
    }
    expect(storage._dump().snapshots.s!.lastSeq).toBe(6);
    expect(storage._dump().events.s!.map((e) => e.seq)).toEqual([7]);
  });

  it('auto-compacts when the tail exceeds `maxEvents`', async () => {
    const storage = memoryStorage();
    const store = createSessionStore({ sessionId: 's', storage, maxEvents: 4 });
    store.append([1, 2, 3, 4, 5].map((i) => ({ type: 'CUSTOM' as const, name: 'n', value: i })));
    await store.flush();
    expect(storage._dump().snapshots.s!.lastSeq).toBe(5);
    expect(storage._dump().events.s).toHaveLength(0);
  });
});

describe('store: quota handling', () => {
  it('on quota error: compacts, retries, then degrades gracefully if still failing', async () => {
    const inner = memoryStorage();
    let failAppends = 0;
    const storage: StorageAdapter = {
      ...inner,
      appendEvents(id, events) {
        if (failAppends > 0) {
          failAppends--;
          throw new StorageQuotaError('full');
        }
        return inner.appendEvents(id, events);
      },
    };
    const onError = vi.fn();
    const store = createSessionStore({ sessionId: 's', storage, onError });
    store.append({ type: 'RUN_STARTED', runId: 'r' });
    await store.flush();

    // One failure → compact + retry succeeds.
    failAppends = 1;
    store.append({ type: 'CUSTOM', name: 'a', value: 1 });
    await store.flush();
    expect(store.degraded).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(inner._dump().snapshots.s!.lastSeq).toBe(1); // snapshot covers what was persisted
    expect(inner._dump().events.s!.map((e) => e.seq)).toEqual([2]);

    // Two failures → retry also fails → degraded, state still updated in memory.
    failAppends = 2;
    store.append({ type: 'CUSTOM', name: 'b', value: 2 });
    await store.flush();
    expect(store.degraded).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(StorageQuotaError), expect.objectContaining({ op: 'append' }));
    expect(store.getState().cursor.lastSeq).toBe(3);

    // Recovers on the next successful write.
    store.append({ type: 'CUSTOM', name: 'c', value: 3 });
    await store.flush();
    expect(store.degraded).toBe(false);
  });
});

describe('store: clear', () => {
  it('wipes storage and resets state', async () => {
    const storage = memoryStorage();
    const store = createSessionStore({ sessionId: 's', storage });
    store.append({ type: 'RUN_STARTED', runId: 'r' });
    await store.flush();
    await store.clear();
    expect(store.getState().status).toBe('idle');
    expect(await storage.loadEventsAfter('s', 0)).toEqual([]);
    expect(await storage.loadSnapshot('s')).toBeNull();
  });
});
