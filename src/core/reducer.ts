import type { MessagePart, SessionEvent } from './events';
import { applyPatch, JsonPatchError } from './json-patch';
import {
  createEmptyState,
  emptyUsageTotals,
  type Message,
  type SessionState,
  type SessionStatus,
  type ToolCall,
  type UsageTotals,
} from './state';

/**
 * Pure reducer: `(state, event) -> state`.
 *
 * - Never mutates its input; every changed container is a new reference, so
 *   React's `useSyncExternalStore` and selector memoisation work as expected.
 * - Deterministic: replaying the same event log from `createEmptyState()`
 *   always yields a deep-equal state.
 * - Tolerant: events that reference unknown ids (e.g. TOOL_CALL_ARGS before
 *   TOOL_CALL_START) create the missing record rather than throwing, so a
 *   partially-replayed stream still produces something sensible.
 */
export function reduce(state: SessionState, event: SessionEvent): SessionState {
  const next = applyEvent(state, event);
  const cursor = {
    ...next.cursor,
    lastSeq: Math.max(next.cursor.lastSeq, event.seq),
  };
  const withCursor: SessionState = {
    ...next,
    cursor,
    lastEventAt: event.ts,
  };
  const status = deriveStatus(withCursor);
  return status === withCursor.status ? withCursor : { ...withCursor, status };
}

/** Reduce a whole log. */
export function replay(sessionId: string, events: Iterable<SessionEvent>, initial?: SessionState): SessionState {
  let s = initial ?? createEmptyState(sessionId);
  for (const e of events) s = reduce(s, e);
  return s;
}

export function deriveStatus(state: SessionState): SessionStatus {
  if (state.pendingApprovals.length > 0) return 'awaiting_approval';
  const runs = Object.values(state.runs);
  if (runs.some((r) => r.status === 'running')) return 'running';
  if (runs.length === 0) return 'idle';
  // Latest run decides between finished / error.
  let latest = runs[0]!;
  for (const r of runs) if (r.startedAt >= latest.startedAt) latest = r;
  if (latest.status === 'error') return 'error';
  return 'finished';
}

// -----------------------------------------------------------------------------

function applyEvent(state: SessionState, e: SessionEvent): SessionState {
  switch (e.type) {
    case 'RUN_STARTED': {
      const existing = state.runs[e.runId];
      return {
        ...state,
        runs: {
          ...state.runs,
          [e.runId]: {
            runId: e.runId,
            threadId: e.threadId,
            parentRunId: e.parentRunId,
            status: 'running',
            startedAt: existing?.startedAt ?? e.ts,
            steps: existing?.steps ?? [],
          },
        },
        cursor: { ...state.cursor, runId: e.runId },
        lastError: undefined,
      };
    }
    case 'RUN_FINISHED': {
      const run = state.runs[e.runId] ?? {
        runId: e.runId,
        status: 'running' as const,
        startedAt: e.ts,
        steps: [],
      };
      return {
        ...state,
        runs: {
          ...state.runs,
          [e.runId]: { ...run, status: 'finished', finishedAt: e.ts, result: e.result, steps: [] },
        },
        cursor: state.cursor.runId === e.runId ? { ...state.cursor, runId: undefined } : state.cursor,
      };
    }
    case 'RUN_ERROR': {
      const runId = e.runId ?? state.cursor.runId;
      const err = { message: e.message, code: e.code };
      let runs = state.runs;
      if (runId) {
        const run = state.runs[runId] ?? { runId, status: 'running' as const, startedAt: e.ts, steps: [] };
        runs = { ...state.runs, [runId]: { ...run, status: 'error', finishedAt: e.ts, error: err } };
      }
      return {
        ...state,
        runs,
        lastError: { ...err, runId },
        cursor: runId && state.cursor.runId === runId ? { ...state.cursor, runId: undefined } : state.cursor,
      };
    }
    case 'STEP_STARTED':
    case 'STEP_FINISHED': {
      const runId = e.runId ?? state.cursor.runId;
      if (!runId) return state;
      const run = state.runs[runId];
      if (!run) return state;
      const steps =
        e.type === 'STEP_STARTED'
          ? [...run.steps, e.stepName]
          : run.steps.filter((s) => s !== e.stepName);
      return { ...state, runs: { ...state.runs, [runId]: { ...run, steps } } };
    }

    // ---- text -------------------------------------------------------------------
    case 'TEXT_MESSAGE_START': {
      const idx = state.messages.findIndex((m) => m.id === e.messageId);
      if (idx >= 0) {
        // Re-opened message: keep what we have (snapshot may have delivered it).
        return state;
      }
      const msg: Message = {
        id: e.messageId,
        role: e.role,
        content: '',
        parts: [],
        runId: e.runId ?? state.cursor.runId,
        createdAt: e.ts,
        complete: false,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case 'TEXT_MESSAGE_CONTENT': {
      return updateMessage(state, e.messageId, e.ts, (m) => ({
        ...m,
        content: m.content + e.delta,
        parts: appendText(m.parts, 'text', e.delta),
      }));
    }
    case 'TEXT_MESSAGE_END': {
      return updateMessage(state, e.messageId, e.ts, (m) => (m.complete ? m : { ...m, complete: true }));
    }

    // ---- reasoning --------------------------------------------------------------
    case 'REASONING_START': {
      const idx = state.messages.findIndex((m) => m.id === e.messageId);
      if (idx >= 0) return state;
      const msg: Message = {
        id: e.messageId,
        role: 'assistant',
        content: '',
        parts: [],
        reasoning: '',
        runId: e.runId ?? state.cursor.runId,
        createdAt: e.ts,
        complete: false,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case 'REASONING_CONTENT': {
      return updateMessage(state, e.messageId, e.ts, (m) => ({
        ...m,
        reasoning: (m.reasoning ?? '') + e.delta,
        parts: appendText(m.parts, 'reasoning', e.delta),
      }));
    }
    case 'REASONING_END':
      return state;

    // ---- tool calls -------------------------------------------------------------
    case 'TOOL_CALL_START': {
      const existing = state.toolCalls[e.toolCallId];
      const tc: ToolCall = {
        id: e.toolCallId,
        name: e.toolCallName,
        argsText: existing?.argsText ?? '',
        args: existing?.args,
        result: existing?.result,
        status: existing?.status ?? 'streaming',
        parentMessageId: e.parentMessageId ?? existing?.parentMessageId,
        parentSubagentId: e.parentSubagentId ?? existing?.parentSubagentId,
        runId: e.runId ?? state.cursor.runId,
        startedAt: existing?.startedAt ?? e.ts,
      };
      let messages = state.messages;
      if (e.parentMessageId) {
        messages = ensureToolCallPart(state, e.parentMessageId, e.toolCallId, e.ts, tc.runId);
      }
      return { ...state, messages, toolCalls: { ...state.toolCalls, [e.toolCallId]: tc } };
    }
    case 'TOOL_CALL_ARGS': {
      const tc = getOrCreateToolCall(state, e.toolCallId, e.ts, e.runId);
      return {
        ...state,
        toolCalls: { ...state.toolCalls, [e.toolCallId]: { ...tc, argsText: tc.argsText + e.delta } },
      };
    }
    case 'TOOL_CALL_END': {
      const tc = getOrCreateToolCall(state, e.toolCallId, e.ts, e.runId);
      const args = parseArgs(tc.argsText);
      const status = tc.status === 'done' || tc.status === 'error' ? tc.status : 'ready';
      return { ...state, toolCalls: { ...state.toolCalls, [e.toolCallId]: { ...tc, args, status } } };
    }
    case 'TOOL_CALL_RESULT': {
      const tc = getOrCreateToolCall(state, e.toolCallId, e.ts, e.runId);
      const args = tc.args === undefined && tc.argsText ? parseArgs(tc.argsText) : tc.args;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]: {
            ...tc,
            args,
            result: e.content,
            isError: e.isError ?? false,
            status: e.isError ? 'error' : 'done',
            finishedAt: e.ts,
          },
        },
      };
    }

    // ---- shared state / activity ------------------------------------------------
    case 'STATE_SNAPSHOT':
      return { ...state, sharedState: e.snapshot };
    case 'STATE_DELTA':
      return { ...state, sharedState: safePatch(state.sharedState, e.delta) };
    case 'ACTIVITY_SNAPSHOT':
      return { ...state, activity: e.snapshot };
    case 'ACTIVITY_DELTA':
      return { ...state, activity: safePatch(state.activity, e.delta) };
    case 'MESSAGES_SNAPSHOT': {
      const byId = new Map(state.messages.map((m) => [m.id, m]));
      const messages: Message[] = e.messages.map((s) => {
        const prev = byId.get(s.id);
        const parts: MessagePart[] = s.parts ?? (s.content ? [{ type: 'text', text: s.content }] : []);
        const content = s.content ?? parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
        return {
          id: s.id,
          role: s.role,
          content,
          parts,
          reasoning: prev?.reasoning,
          runId: prev?.runId ?? e.runId ?? state.cursor.runId,
          createdAt: prev?.createdAt ?? e.ts,
          complete: true,
        };
      });
      let toolCalls = state.toolCalls;
      for (const s of e.messages) {
        for (const c of s.toolCalls ?? []) {
          const existing = toolCalls[c.id];
          if (!existing) {
            toolCalls = {
              ...toolCalls,
              [c.id]: {
                id: c.id,
                name: c.name,
                argsText: c.args === undefined ? '' : JSON.stringify(c.args),
                args: c.args,
                status: 'ready',
                parentMessageId: s.id,
                runId: e.runId ?? state.cursor.runId,
                startedAt: e.ts,
              },
            };
          }
        }
      }
      return { ...state, messages, toolCalls };
    }

    // ---- subagents ----------------------------------------------------------------
    case 'SUBAGENT_STARTED': {
      const existing = state.subagents[e.subagentId];
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [e.subagentId]: {
            id: e.subagentId,
            name: e.name,
            parentId: e.parentId,
            status: 'running',
            startedAt: existing?.startedAt ?? e.ts,
            input: e.input,
            runId: e.runId ?? state.cursor.runId,
          },
        },
      };
    }
    case 'SUBAGENT_FINISHED': {
      const s = state.subagents[e.subagentId] ?? {
        id: e.subagentId,
        name: e.subagentId,
        status: 'running' as const,
        startedAt: e.ts,
      };
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [e.subagentId]: { ...s, status: 'finished', finishedAt: e.ts, output: e.output },
        },
      };
    }
    case 'SUBAGENT_ERROR': {
      const s = state.subagents[e.subagentId] ?? {
        id: e.subagentId,
        name: e.subagentId,
        status: 'running' as const,
        startedAt: e.ts,
      };
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [e.subagentId]: { ...s, status: 'error', finishedAt: e.ts, error: e.message },
        },
      };
    }

    // ---- approvals ------------------------------------------------------------------
    case 'APPROVAL_REQUESTED': {
      if (state.resolvedApprovals[e.approvalId]) return state; // already resolved; ignore replays
      if (state.pendingApprovals.some((a) => a.approvalId === e.approvalId)) return state;
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          {
            approvalId: e.approvalId,
            toolCallId: e.toolCallId,
            kind: e.kind,
            title: e.title,
            payload: e.payload,
            options: e.options,
            expiresAt: e.expiresAt,
            requestedAt: e.ts,
            runId: e.runId ?? state.cursor.runId,
            threadId: e.threadId,
          },
        ],
      };
    }
    case 'APPROVAL_RESOLVED': {
      if (state.resolvedApprovals[e.approvalId]) return state;
      const resolution = {
        approvalId: e.approvalId,
        decision: e.decision,
        payload: e.payload,
        resolvedBy: e.resolvedBy,
        resolvedAt: e.ts,
        runId: e.runId,
        threadId: e.threadId,
      };
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== e.approvalId),
        resolvedApprovals: { ...state.resolvedApprovals, [e.approvalId]: resolution },
        outbox: [...state.outbox, resolution],
      };
    }
    case 'APPROVAL_DELIVERED': {
      if (!state.outbox.some((r) => r.approvalId === e.approvalId)) return state;
      return { ...state, outbox: state.outbox.filter((r) => r.approvalId !== e.approvalId) };
    }

    // ---- usage ------------------------------------------------------------------------
    case 'USAGE': {
      const add = (t: UsageTotals): UsageTotals => ({
        inputTokens: t.inputTokens + e.inputTokens,
        outputTokens: t.outputTokens + e.outputTokens,
        cachedInputTokens: t.cachedInputTokens + (e.cachedInputTokens ?? 0),
        costUsd: round(t.costUsd + (e.costUsd ?? 0)),
        calls: t.calls + 1,
      });
      return {
        ...state,
        usage: {
          totals: add(state.usage.totals),
          byModel: { ...state.usage.byModel, [e.model]: add(state.usage.byModel[e.model] ?? emptyUsageTotals()) },
        },
      };
    }

    // ---- misc -------------------------------------------------------------------------
    case 'CHECKPOINT':
      return {
        ...state,
        checkpoints: [...state.checkpoints, { label: e.label, seq: e.seq, ts: e.ts }],
        sharedState: e.state !== undefined ? e.state : state.sharedState,
      };
    case 'STREAM_CURSOR':
      return { ...state, cursor: { ...state.cursor, streamCursor: e.cursor } };
    case 'CUSTOM':
    case 'RAW':
      return state;
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return state;
    }
  }
}

// -----------------------------------------------------------------------------

function round(n: number): number {
  // Avoid float drift accumulating visibly in cost totals.
  return Math.round(n * 1e10) / 1e10;
}

function parseArgs(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function safePatch(doc: unknown, ops: Parameters<typeof applyPatch>[1]): unknown {
  try {
    return applyPatch(doc ?? {}, ops);
  } catch (e) {
    if (e instanceof JsonPatchError) return doc; // keep last good state; don't poison replay
    throw e;
  }
}

function appendText(parts: MessagePart[], type: 'text' | 'reasoning', delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    return [...parts.slice(0, -1), { type, text: last.text + delta }];
  }
  return [...parts, { type, text: delta }];
}

function updateMessage(
  state: SessionState,
  messageId: string,
  ts: number,
  fn: (m: Message) => Message,
): SessionState {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    const created: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      parts: [],
      runId: state.cursor.runId,
      createdAt: ts,
      complete: false,
    };
    return { ...state, messages: [...state.messages, fn(created)] };
  }
  const prev = state.messages[idx]!;
  const updated = fn(prev);
  if (updated === prev) return state;
  const messages = state.messages.slice();
  messages[idx] = updated;
  return { ...state, messages };
}

function ensureToolCallPart(
  state: SessionState,
  messageId: string,
  toolCallId: string,
  ts: number,
  runId: string | undefined,
): Message[] {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    return [
      ...state.messages,
      {
        id: messageId,
        role: 'assistant',
        content: '',
        parts: [{ type: 'tool-call', toolCallId }],
        runId,
        createdAt: ts,
        complete: false,
      },
    ];
  }
  const m = state.messages[idx]!;
  if (m.parts.some((p) => p.type === 'tool-call' && p.toolCallId === toolCallId)) return state.messages;
  const messages = state.messages.slice();
  messages[idx] = { ...m, parts: [...m.parts, { type: 'tool-call', toolCallId }] };
  return messages;
}

function getOrCreateToolCall(state: SessionState, id: string, ts: number, runId: string | undefined): ToolCall {
  return (
    state.toolCalls[id] ?? {
      id,
      name: '',
      argsText: '',
      status: 'streaming',
      runId: runId ?? state.cursor.runId,
      startedAt: ts,
    }
  );
}
