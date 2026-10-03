import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ApprovalDecision, EventInput } from '../core/events';
import {
  subagentTree,
  type Approval,
  type Cursor,
  type Message,
  type SessionState,
  type SessionStatus,
  type SubagentNode,
  type ToolCall,
  type UsageState,
} from '../core/state';
import type { SessionStore } from '../core/store';

/**
 * Subscribe to a derived slice of the store. The selector result is compared
 * with `isEqual` (default `Object.is`) so components only re-render when the
 * slice changes. Server snapshot is the same as the client snapshot: the store
 * starts empty on both sides and `hydrate()` runs in an effect.
 */
export function useSessionSelector<T>(
  store: SessionStore,
  selector: (state: SessionState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const lastRef = useRef<{ state: SessionState; value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const last = lastRef.current;
    if (last && last.state === state) return last.value;
    const value = selectorRef.current(state);
    if (last && isEqualRef.current(last.value, value)) {
      lastRef.current = { state, value: last.value };
      return last.value;
    }
    lastRef.current = { state, value };
    return value;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Run `store.hydrate()` once per store (in an effect) and report when it is done. */
export function useHydrate(store: SessionStore): boolean {
  const hydrated = useSessionSelector(store, () => store.hydrated);
  useEffect(() => {
    void store.hydrate();
  }, [store]);
  return hydrated;
}

export interface AgentSession {
  state: SessionState;
  status: SessionStatus;
  /** true after `hydrate()` has completed (successfully or not). */
  hydrated: boolean;
  resolveApproval: (approvalId: string, decision: ApprovalDecision, payload?: unknown) => void;
  append: SessionStore['append'];
  store: SessionStore;
}

/** Whole-state hook. Prefer the selector hooks below in large trees. */
export function useAgentSession(store: SessionStore): AgentSession {
  const state = useSessionSelector(store, (s) => s);
  const hydrated = useHydrate(store);
  const resolveApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision, payload?: unknown) => {
      store.resolveApproval(approvalId, decision, payload);
    },
    [store],
  );
  const append = useCallback<SessionStore['append']>((input: EventInput | EventInput[]) => store.append(input), [store]);
  return useMemo(
    () => ({ state, status: state.status, hydrated, resolveApproval, append, store }),
    [state, hydrated, resolveApproval, append, store],
  );
}

export function usePendingApprovals(store: SessionStore): Approval[] {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.pendingApprovals);
}

export function useSubagentTree(store: SessionStore): SubagentNode[] {
  useHydrate(store);
  const subagents = useSessionSelector(store, (s) => s.subagents);
  return useMemo(() => subagentTree(subagents), [subagents]);
}

export function useUsage(store: SessionStore): UsageState {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.usage);
}

export function useToolCalls(store: SessionStore, filter?: (tc: ToolCall) => boolean): ToolCall[] {
  useHydrate(store);
  const toolCalls = useSessionSelector(store, (s) => s.toolCalls);
  return useMemo(() => {
    const list = Object.values(toolCalls).sort((a, b) => a.startedAt - b.startedAt);
    return filter ? list.filter(filter) : list;
  }, [toolCalls, filter]);
}

export function useMessages(store: SessionStore): Message[] {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.messages);
}

export function useResumeCursor(store: SessionStore): Cursor {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.cursor);
}

export function useSessionStatus(store: SessionStore): SessionStatus {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.status);
}

/** Resolutions waiting to be delivered to the backend (survive reload). */
export function useOutbox(store: SessionStore) {
  useHydrate(store);
  return useSessionSelector(store, (s) => s.outbox);
}
