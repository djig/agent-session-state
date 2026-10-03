import type { EventInput, Role } from '../core/events';
import type { Resolution, SessionState } from '../core/state';
import type { SessionStore } from '../core/store';

/**
 * Structural types matching Vercel AI SDK v5/v6 `UIMessage`. Defined locally
 * so this package does not depend on `ai`; anything with this shape works.
 */
export type UIToolState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error'
  | 'approval-requested'
  | 'approval-responded';

export interface UIToolPart {
  /** `tool-<name>` (static tools) or `dynamic-tool`. */
  type: string;
  toolCallId: string;
  toolName?: string;
  state: UIToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
  providerExecuted?: boolean;
}

export type UIMessagePart =
  | { type: 'text'; text: string; state?: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
  | { type: 'step-start' }
  | { type: 'file'; mediaType: string; url: string; filename?: string }
  | { type: 'source-url'; sourceId: string; url: string; title?: string }
  | { type: 'source-document'; sourceId: string; mediaType: string; title: string }
  | UIToolPart
  | { type: `data-${string}`; id?: string; data: unknown };

export interface UIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: UIMessagePart[];
  metadata?: unknown;
}

export interface FromUIMessagesOptions {
  runId?: string;
  threadId?: string;
  /** Approval id to use for a tool awaiting approval. Default: `part.approval.id` ?? `toolCallId`. */
  approvalId?: (part: UIToolPart, message: UIMessage) => string;
  /** Title shown for tool approvals. Default: `Approve <toolName>?` */
  approvalTitle?: (part: UIToolPart, message: UIMessage) => string;
}

function isToolPart(p: UIMessagePart): p is UIToolPart {
  return (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) && 'toolCallId' in p;
}

function toolName(p: UIToolPart): string {
  return p.toolName ?? (p.type === 'dynamic-tool' ? 'dynamic-tool' : p.type.slice('tool-'.length));
}

function text(parts: UIMessagePart[], type: 'text' | 'reasoning'): string {
  return parts
    .filter((p) => p.type === type)
    .map((p) => (p as { text: string }).text)
    .join('');
}

/**
 * Diff an AI SDK `UIMessage[]` against the store's current state and return
 * the events needed to bring the store up to date. Idempotent: given the same
 * messages twice, the second call returns `[]`.
 *
 * Mapping:
 * - message text         → TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT (delta vs. stored) / TEXT_MESSAGE_END
 * - reasoning parts      → REASONING_CONTENT (delta)
 * - tool part            → TOOL_CALL_START + ARGS + END once input is available; RESULT on output
 * - `approval-requested` → APPROVAL_REQUESTED (kind 'tool')
 * - `approval-responded` → APPROVAL_RESOLVED (resolvedBy 'user')
 */
export function fromUIMessages(
  messages: UIMessage[],
  state: SessionState,
  options: FromUIMessagesOptions = {},
): EventInput[] {
  const out: EventInput[] = [];
  const common = { runId: options.runId, threadId: options.threadId };
  const stored = new Map(state.messages.map((m) => [m.id, m]));

  // A regenerated/edited message (stored text is not a prefix of the new text)
  // cannot be expressed as a delta. Fall back to one MESSAGES_SNAPSHOT covering
  // every message, and skip per-message text events for this call.
  const rewritten = messages.some((msg) => {
    const prev = stored.get(msg.id);
    if (!prev) return false;
    const full = text(msg.parts, 'text');
    return full !== prev.content && !full.startsWith(prev.content);
  });
  if (rewritten) {
    out.push({
      type: 'MESSAGES_SNAPSHOT',
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: text(m.parts, 'text'),
        toolCalls: m.parts.filter(isToolPart).map((p) => ({ id: p.toolCallId, name: toolName(p), args: p.input })),
      })),
      ...common,
    });
  }

  for (const msg of messages) {
    const prev = stored.get(msg.id);
    const fullText = text(msg.parts, 'text');
    const fullReasoning = text(msg.parts, 'reasoning');
    const hasTextLikeParts = msg.parts.some((p) => p.type === 'text' || p.type === 'reasoning');
    const isStreaming = msg.parts.some(
      (p) => (p.type === 'text' || p.type === 'reasoning') && (p as { state?: string }).state === 'streaming',
    );

    if (!rewritten) {
      if (!prev && (hasTextLikeParts || msg.parts.length === 0)) {
        out.push({ type: 'TEXT_MESSAGE_START', messageId: msg.id, role: msg.role as Role, ...common });
      }
      const prevText = prev?.content ?? '';
      if (fullText.length > prevText.length && fullText.startsWith(prevText)) {
        out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: msg.id, delta: fullText.slice(prevText.length), ...common });
      }
      const prevReasoning = prev?.reasoning ?? '';
      if (fullReasoning.length > prevReasoning.length && fullReasoning.startsWith(prevReasoning)) {
        if (!prev && !hasTextLikeParts) out.push({ type: 'REASONING_START', messageId: msg.id, ...common });
        out.push({ type: 'REASONING_CONTENT', messageId: msg.id, delta: fullReasoning.slice(prevReasoning.length), ...common });
      }
      const willBeComplete = !isStreaming && (hasTextLikeParts || msg.parts.length === 0);
      const started = prev !== undefined || out.some((e) => e.type === 'TEXT_MESSAGE_START' && e.messageId === msg.id);
      if (willBeComplete && !(prev?.complete ?? false) && started) {
        out.push({ type: 'TEXT_MESSAGE_END', messageId: msg.id, ...common });
      }
    }

    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      const tc = state.toolCalls[part.toolCallId];
      const name = toolName(part);
      const inputReady = part.state !== 'input-streaming';
      const argsText = part.input === undefined ? '' : JSON.stringify(part.input);

      if (!tc) {
        // (When `rewritten`, the MESSAGES_SNAPSHOT above already registered the call.)
        if (!rewritten) {
          out.push({ type: 'TOOL_CALL_START', toolCallId: part.toolCallId, toolCallName: name, parentMessageId: msg.id, ...common });
          if (inputReady) {
            if (argsText) out.push({ type: 'TOOL_CALL_ARGS', toolCallId: part.toolCallId, delta: argsText, ...common });
            out.push({ type: 'TOOL_CALL_END', toolCallId: part.toolCallId, ...common });
          }
        }
      } else if (inputReady && tc.status === 'streaming') {
        if (argsText && argsText !== tc.argsText) {
          out.push({ type: 'TOOL_CALL_ARGS', toolCallId: part.toolCallId, delta: argsText.slice(tc.argsText.length), ...common });
        }
        out.push({ type: 'TOOL_CALL_END', toolCallId: part.toolCallId, ...common });
      }

      const hasResult = tc?.status === 'done' || tc?.status === 'error';
      if (part.state === 'output-available' && !hasResult) {
        out.push({ type: 'TOOL_CALL_RESULT', toolCallId: part.toolCallId, messageId: msg.id, content: part.output, role: 'tool', ...common });
      } else if (part.state === 'output-error' && !hasResult) {
        out.push({
          type: 'TOOL_CALL_RESULT',
          toolCallId: part.toolCallId,
          messageId: msg.id,
          content: part.errorText ?? 'error',
          role: 'tool',
          isError: true,
          ...common,
        });
      }

      const approvalId = options.approvalId?.(part, msg) ?? part.approval?.id ?? part.toolCallId;
      const pending = state.pendingApprovals.some((a) => a.approvalId === approvalId);
      const resolved = approvalId in state.resolvedApprovals;
      if (part.state === 'approval-requested' && !pending && !resolved) {
        out.push({
          type: 'APPROVAL_REQUESTED',
          approvalId,
          toolCallId: part.toolCallId,
          kind: 'tool',
          title: options.approvalTitle?.(part, msg) ?? `Approve ${name}?`,
          payload: part.input,
          ...common,
        });
      } else if (part.state === 'approval-responded' && !resolved) {
        if (!pending) {
          // We never saw the request (e.g. hydrated from a server-side history). Record both.
          out.push({
            type: 'APPROVAL_REQUESTED',
            approvalId,
            toolCallId: part.toolCallId,
            kind: 'tool',
            title: options.approvalTitle?.(part, msg) ?? `Approve ${name}?`,
            payload: part.input,
            ...common,
          });
        }
        out.push({
          type: 'APPROVAL_RESOLVED',
          approvalId,
          decision: part.approval?.approved === false ? 'reject' : 'approve',
          payload: part.approval?.reason !== undefined ? { reason: part.approval.reason } : undefined,
          resolvedBy: 'user',
          ...common,
        });
      }
    }
  }
  return out;
}

/** Convenience: diff + append in one call. Returns the appended events. */
export function syncUIMessages(store: SessionStore, messages: UIMessage[], options?: FromUIMessagesOptions) {
  const events = fromUIMessages(messages, store.getState(), options);
  return events.length ? store.append(events) : [];
}

export interface ToolApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

/**
 * Convert a resolution from the store into the argument for AI SDK's
 * `addToolApprovalResponse({ id, approved, reason })`.
 * Note: AI SDK's `id` is the *approval* id (`part.approval.id`), which
 * `fromUIMessages` uses as `approvalId` when present.
 */
export function toToolApprovalResponse(resolution: Pick<Resolution, 'approvalId' | 'decision' | 'payload'>): ToolApprovalResponse {
  const payload = resolution.payload as { reason?: string } | undefined;
  return {
    id: resolution.approvalId,
    approved: resolution.decision === 'approve' || resolution.decision === 'edit' || resolution.decision === 'answer',
    reason: payload?.reason,
  };
}
