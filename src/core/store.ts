import type {
  ApprovalDecision,
  ApprovalResolvedEvent,
  EventInput,
  SessionEvent,
} from './events';
import { reduce } from './reducer';
import { createEmptyState, type Cursor, type Resolution, type SessionState } from './state';
import { isQuotaError, type Snapshot, type StorageAdapter } from './storage';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached input tokens. Defaults to `inputPerMTok` when absent. */
  cachedInputPerMTok?: number;
}

export type PricingTable = Record<string, ModelPricing>;

export interface SessionStoreOptions {
  sessionId: string;
  storage: StorageAdapter;
  /** BYO pricing. `USAGE` events without `costUsd` get it computed when the model is known. */
  pricing?: PricingTable;
  /** Clock used for `ts`. Defaults to `Date.now`. */
  clock?: () => number;
  /** Compact (snapshot + trim) whenever the tail log grows past this many events. */
  maxEvents?: number;
  /** Compact every N appended events. */
  snapshotEvery?: number;
  /**
   * Called after `resolveApproval` to push the resolution to your backend.
   * Resolve → the approval is marked delivered. Reject/throw → it stays in the
   * outbox so you can retry with `deliverOutbox()` (e.g. after reload or reconnect).
   */
  onDeliver?: (resolution: Resolution, state: SessionState) => Promise<void> | void;
  /** Persistence / delivery errors are reported here instead of thrown. Defaults to console.warn. */
  onError?: (error: unknown, context: StoreErrorContext) => void;
}

export type StoreErrorContext =
  | { op: 'hydrate' }
  | { op: 'append'; events: SessionEvent[] }
  | { op: 'compact' }
  | { op: 'deliver'; approvalId: string }
  | { op: 'clear' };

export type Listener = (state: SessionState) => void;

export interface SessionStore {
  readonly sessionId: string;
  readonly storage: StorageAdapter;
  getState(): SessionState;
  subscribe(listener: Listener): () => void;
  /** Append one or more events. `seq` and `ts` are assigned. Returns the accepted events. */
  append(input: EventInput | EventInput[]): SessionEvent[];
  /** Load snapshot + tail from storage and replay. Idempotent; safe to call many times. */
  hydrate(): Promise<SessionState>;
  /** true once `hydrate()` has completed (successfully or not). */
  readonly hydrated: boolean;
  /** Resolve a pending approval. Appends APPROVAL_RESOLVED and tries `onDeliver`. */
  resolveApproval(approvalId: string, decision: ApprovalDecision, payload?: unknown): Resolution | null;
  /** Mark an outbox resolution as delivered to the backend. */
  markDelivered(approvalId: string): void;
  /** Re-attempt `onDeliver` for everything still in the outbox. */
  deliverOutbox(): Promise<void>;
  getResumeCursor(): Cursor;
  /** Write a snapshot and trim the event log. */
  compact(): Promise<void>;
  /** Wait for all pending storage writes. */
  flush(): Promise<void>;
  /** Wipe this session from storage and reset to empty state. */
  clear(): Promise<void>;
  /** true when the last persistence attempt failed; state is in-memory only until a write succeeds. */
  readonly degraded: boolean;
}

export function computeCost(
  pricing: PricingTable | undefined,
  usage: { model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | undefined {
  const p = pricing?.[usage.model];
  if (!p) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cost =
    (uncached * p.inputPerMTok + cached * (p.cachedInputPerMTok ?? p.inputPerMTok) + usage.outputTokens * p.outputPerMTok) /
    1_000_000;
  return Math.round(cost * 1e10) / 1e10;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const { sessionId, storage, pricing, maxEvents, snapshotEvery, onDeliver } = options;
  const clock = options.clock ?? (() => Date.now());
  const onError =
    options.onError ??
    ((err: unknown, ctx: StoreErrorContext) => {
      if (typeof console !== 'undefined') console.warn(`[agent-session-state] ${ctx.op} failed`, err);
    });

  let state: SessionState = createEmptyState(sessionId);
  const listeners = new Set<Listener>();
  let hydrated = false;
  let hydrating: Promise<SessionState> | null = null;
  /** Events appended before hydration finished; rebased onto the hydrated state afterwards. */
  let preHydrateBuffer: SessionEvent[] = [];
  let writeChain: Promise<void> = Promise.resolve();
  let degraded = false;
  let sinceSnapshot = 0;
  let tailCount = 0;
  /** State as of the last successfully persisted event; what compaction snapshots. */
  let persistedState: SessionState = state;

  function emit() {
    for (const l of Array.from(listeners)) l(state);
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    writeChain = writeChain.then(task, task);
    return writeChain;
  }

  function normalize(input: EventInput, seq: number): SessionEvent {
    const e = { ...input } as SessionEvent;
    e.seq = seq;
    if (typeof e.ts !== 'number') e.ts = clock();
    if (e.runId === undefined && state.cursor.runId && e.type !== 'RUN_STARTED') e.runId = state.cursor.runId;
    if (e.type === 'USAGE' && e.costUsd === undefined) {
      const cost = computeCost(pricing, e);
      if (cost !== undefined) e.costUsd = cost;
    }
    return e;
  }

  async function persist(events: SessionEvent[], stateAfter: SessionState): Promise<void> {
    if (events.length === 0) return;
    try {
      await storage.appendEvents(sessionId, events);
      degraded = false;
      persistedState = stateAfter;
      tailCount += events.length;
      sinceSnapshot += events.length;
    } catch (err) {
      if (isQuotaError(err)) {
        // Free space by snapshotting + trimming, then retry once.
        try {
          await doCompact();
          await storage.appendEvents(sessionId, events);
          degraded = false;
          persistedState = stateAfter;
          tailCount += events.length;
          sinceSnapshot += events.length;
          return;
        } catch (err2) {
          degraded = true;
          onError(err2, { op: 'append', events });
          return;
        }
      }
      degraded = true;
      onError(err, { op: 'append', events });
      return;
    }
    if ((snapshotEvery && sinceSnapshot >= snapshotEvery) || (maxEvents && tailCount > maxEvents)) {
      try {
        await doCompact();
      } catch (err) {
        onError(err, { op: 'compact' });
      }
    }
  }

  async function doCompact(): Promise<void> {
    const snap: Snapshot = { state: persistedState, lastSeq: persistedState.cursor.lastSeq, savedAt: clock() };
    await storage.saveSnapshot(sessionId, snap);
    if (storage.trimEvents) await storage.trimEvents(sessionId, snap.lastSeq);
    sinceSnapshot = 0;
    tailCount = 0;
  }

  function append(input: EventInput | EventInput[]): SessionEvent[] {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) return [];
    const accepted: SessionEvent[] = [];
    let next = state;
    for (const i of inputs) {
      const e = normalize(i, next.cursor.lastSeq + 1);
      next = reduce(next, e);
      accepted.push(e);
    }
    state = next;
    emit();
    if (!hydrated) {
      preHydrateBuffer.push(...accepted);
      // Kick off hydration so the buffer eventually drains even if the app never calls hydrate().
      void hydrate();
    } else {
      const stateAfter = state;
      void enqueue(() => persist(accepted, stateAfter));
    }
    return accepted;
  }

  function hydrate(): Promise<SessionState> {
    if (hydrating) return hydrating;
    hydrating = (async () => {
      let base = createEmptyState(sessionId);
      try {
        const snap = await storage.loadSnapshot(sessionId);
        if (snap && snap.state) {
          base = { ...createEmptyState(sessionId), ...snap.state, sessionId };
          base.cursor = { ...base.cursor, lastSeq: Math.max(base.cursor.lastSeq, snap.lastSeq) };
        }
        const tail = await storage.loadEventsAfter(sessionId, base.cursor.lastSeq);
        tail.sort((a, b) => a.seq - b.seq);
        for (const e of tail) base = reduce(base, e);
        tailCount = tail.length;
        sinceSnapshot = tail.length;
      } catch (err) {
        onError(err, { op: 'hydrate' });
      }
      // Rebase anything appended optimistically before hydration finished.
      persistedState = base;
      const buffered = preHydrateBuffer;
      preHydrateBuffer = [];
      const rebased: SessionEvent[] = [];
      for (const e of buffered) {
        const re = { ...e, seq: base.cursor.lastSeq + 1 };
        base = reduce(base, re);
        rebased.push(re);
      }
      state = base;
      hydrated = true;
      emit();
      const stateAfter = state;
      if (rebased.length) await enqueue(() => persist(rebased, stateAfter));
      return state;
    })();
    return hydrating;
  }

  function markDelivered(approvalId: string): void {
    if (!state.outbox.some((r) => r.approvalId === approvalId)) return;
    append({ type: 'APPROVAL_DELIVERED', approvalId });
  }

  async function deliver(resolution: Resolution): Promise<void> {
    if (!onDeliver) return;
    try {
      await onDeliver(resolution, state);
      markDelivered(resolution.approvalId);
    } catch (err) {
      onError(err, { op: 'deliver', approvalId: resolution.approvalId });
    }
  }

  function resolveApproval(approvalId: string, decision: ApprovalDecision, payload?: unknown): Resolution | null {
    const pending = state.pendingApprovals.find((a) => a.approvalId === approvalId);
    if (!pending) return null;
    const ev: EventInput<ApprovalResolvedEvent> = {
      type: 'APPROVAL_RESOLVED',
      approvalId,
      decision,
      payload,
      resolvedBy: 'user',
      runId: pending.runId,
      threadId: pending.threadId,
    };
    append(ev);
    const resolution = state.resolvedApprovals[approvalId] ?? null;
    if (resolution) void deliver(resolution);
    return resolution;
  }

  async function deliverOutbox(): Promise<void> {
    for (const r of [...state.outbox]) await deliver(r);
  }

  async function clear(): Promise<void> {
    await enqueue(async () => {
      try {
        await storage.clear(sessionId);
      } catch (err) {
        onError(err, { op: 'clear' });
      }
    });
    state = createEmptyState(sessionId);
    persistedState = state;
    preHydrateBuffer = [];
    tailCount = 0;
    sinceSnapshot = 0;
    emit();
  }

  return {
    sessionId,
    storage,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    append,
    hydrate,
    get hydrated() {
      return hydrated;
    },
    get degraded() {
      return degraded;
    },
    resolveApproval,
    markDelivered,
    deliverOutbox,
    getResumeCursor: () => ({ ...state.cursor }),
    compact: () =>
      enqueue(async () => {
        try {
          await doCompact();
        } catch (err) {
          onError(err, { op: 'compact' });
        }
      }),
    flush: async () => {
      if (hydrating) await hydrating;
      await writeChain;
      // A persist may have enqueued a compaction; wait for that too.
      await writeChain;
    },
    clear,
  };
}
