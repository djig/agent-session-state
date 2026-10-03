import type { ApprovalKind, Role } from './events';
import type { SessionStore } from './store';

let counter = 0;
function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}${counter.toString(36)}`;
}

/**
 * Convenience helpers for hand-rolled transports (custom SSE, WebSockets,
 * polling). Each helper appends the right event(s) to the store and returns
 * any generated ids so you can correlate follow-ups.
 */
export function createEmitter(store: SessionStore) {
  return {
    startRun(opts: { runId?: string; threadId?: string; parentRunId?: string } = {}) {
      const runId = opts.runId ?? uid('run');
      store.append({ type: 'RUN_STARTED', runId, threadId: opts.threadId, parentRunId: opts.parentRunId });
      return runId;
    },
    finishRun(runId?: string, result?: unknown) {
      const id = runId ?? store.getState().cursor.runId;
      if (!id) return;
      store.append({ type: 'RUN_FINISHED', runId: id, result });
    },
    errorRun(message: string, opts: { runId?: string; code?: string } = {}) {
      store.append({ type: 'RUN_ERROR', message, code: opts.code, runId: opts.runId ?? store.getState().cursor.runId });
    },
    step(stepName: string, phase: 'start' | 'finish') {
      store.append({ type: phase === 'start' ? 'STEP_STARTED' : 'STEP_FINISHED', stepName });
    },
    /** Start a message (returns its id). */
    startMessage(role: Role = 'assistant', messageId?: string) {
      const id = messageId ?? uid('msg');
      store.append({ type: 'TEXT_MESSAGE_START', messageId: id, role });
      return id;
    },
    /** Append a text delta. Starts the message if it does not exist yet. */
    text(messageId: string, delta: string) {
      const exists = store.getState().messages.some((m) => m.id === messageId);
      if (!exists) store.append({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      store.append({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
    },
    endMessage(messageId: string) {
      store.append({ type: 'TEXT_MESSAGE_END', messageId });
    },
    /** Record a complete tool call in one go (START + ARGS + END, optionally RESULT). */
    toolCall(opts: {
      toolCallId?: string;
      name: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      parentMessageId?: string;
      parentSubagentId?: string;
    }) {
      const toolCallId = opts.toolCallId ?? uid('call');
      store.append([
        {
          type: 'TOOL_CALL_START',
          toolCallId,
          toolCallName: opts.name,
          parentMessageId: opts.parentMessageId,
          parentSubagentId: opts.parentSubagentId,
        },
        { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(opts.args ?? {}) },
        { type: 'TOOL_CALL_END', toolCallId },
        ...(opts.result !== undefined
          ? [{ type: 'TOOL_CALL_RESULT' as const, toolCallId, content: opts.result, isError: opts.isError }]
          : []),
      ]);
      return toolCallId;
    },
    toolResult(toolCallId: string, content: unknown, isError = false) {
      store.append({ type: 'TOOL_CALL_RESULT', toolCallId, content, isError });
    },
    requestApproval(opts: {
      approvalId?: string;
      toolCallId?: string;
      kind?: ApprovalKind;
      title: string;
      payload?: unknown;
      options?: string[];
      expiresAt?: number;
    }) {
      const approvalId = opts.approvalId ?? uid('apr');
      store.append({
        type: 'APPROVAL_REQUESTED',
        approvalId,
        toolCallId: opts.toolCallId,
        kind: opts.kind ?? 'tool',
        title: opts.title,
        payload: opts.payload,
        options: opts.options,
        expiresAt: opts.expiresAt,
      });
      return approvalId;
    },
    usage(opts: { model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number }) {
      store.append({ type: 'USAGE', ...opts });
    },
    subagentStarted(opts: { subagentId?: string; name: string; parentId?: string; input?: unknown }) {
      const subagentId = opts.subagentId ?? uid('sub');
      store.append({ type: 'SUBAGENT_STARTED', subagentId, name: opts.name, parentId: opts.parentId, input: opts.input });
      return subagentId;
    },
    subagentFinished(subagentId: string, output?: unknown) {
      store.append({ type: 'SUBAGENT_FINISHED', subagentId, output });
    },
    subagentError(subagentId: string, message: string) {
      store.append({ type: 'SUBAGENT_ERROR', subagentId, message });
    },
    stateSnapshot(snapshot: unknown) {
      store.append({ type: 'STATE_SNAPSHOT', snapshot });
    },
    checkpoint(label: string, state?: unknown) {
      store.append({ type: 'CHECKPOINT', label, state });
    },
    cursor(cursor: string) {
      store.append({ type: 'STREAM_CURSOR', cursor });
    },
    custom(name: string, value: unknown) {
      store.append({ type: 'CUSTOM', name, value });
    },
  };
}

export type Emitter = ReturnType<typeof createEmitter>;
