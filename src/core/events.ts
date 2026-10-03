/**
 * Session event log types.
 *
 * Every event carries a `seq` (assigned by the store, monotonically increasing
 * per session), a `ts` (epoch millis), and optional `runId` / `threadId`.
 * Event names follow AG-UI where an equivalent exists; the rest are this
 * library's own (approvals, usage, checkpoints, stream cursors).
 */

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'developer';

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

export type ApprovalKind = 'tool' | 'plan' | 'question' | 'custom';
export type ApprovalDecision = 'approve' | 'reject' | 'edit' | 'answer' | 'timeout';
export type ResolvedBy = 'user' | 'system';

/** Fields common to every event once it has been accepted by the store. */
export interface EventBase {
  seq: number;
  ts: number;
  runId?: string;
  threadId?: string;
}

/** A snapshot of a message, used by MESSAGES_SNAPSHOT. */
export interface MessageSnapshot {
  id: string;
  role: Role;
  content?: string;
  parts?: MessagePart[];
  toolCalls?: Array<{ id: string; name: string; args?: unknown }>;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string }
  | { type: 'file'; mediaType?: string; url?: string; filename?: string }
  | { type: 'source'; url?: string; title?: string }
  | { type: 'data'; name: string; data: unknown };

// ---- AG-UI lifecycle ---------------------------------------------------------

export interface RunStartedEvent extends EventBase {
  type: 'RUN_STARTED';
  runId: string;
  threadId?: string;
  parentRunId?: string;
}
export interface RunFinishedEvent extends EventBase {
  type: 'RUN_FINISHED';
  runId: string;
  result?: unknown;
}
export interface RunErrorEvent extends EventBase {
  type: 'RUN_ERROR';
  message: string;
  code?: string;
}
export interface StepStartedEvent extends EventBase {
  type: 'STEP_STARTED';
  stepName: string;
}
export interface StepFinishedEvent extends EventBase {
  type: 'STEP_FINISHED';
  stepName: string;
}

// ---- AG-UI text ---------------------------------------------------------------

export interface TextMessageStartEvent extends EventBase {
  type: 'TEXT_MESSAGE_START';
  messageId: string;
  role: Role;
}
export interface TextMessageContentEvent extends EventBase {
  type: 'TEXT_MESSAGE_CONTENT';
  messageId: string;
  delta: string;
}
export interface TextMessageEndEvent extends EventBase {
  type: 'TEXT_MESSAGE_END';
  messageId: string;
}

// ---- AG-UI tool calls ---------------------------------------------------------

export interface ToolCallStartEvent extends EventBase {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  /** This library's extension: which subagent issued the call. */
  parentSubagentId?: string;
}
export interface ToolCallArgsEvent extends EventBase {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  delta: string;
}
export interface ToolCallEndEvent extends EventBase {
  type: 'TOOL_CALL_END';
  toolCallId: string;
}
export interface ToolCallResultEvent extends EventBase {
  type: 'TOOL_CALL_RESULT';
  toolCallId: string;
  messageId?: string;
  content: unknown;
  role?: 'tool';
  isError?: boolean;
}

// ---- AG-UI state ---------------------------------------------------------------

export interface StateSnapshotEvent extends EventBase {
  type: 'STATE_SNAPSHOT';
  snapshot: unknown;
}
export interface StateDeltaEvent extends EventBase {
  type: 'STATE_DELTA';
  delta: JsonPatchOp[];
}
export interface MessagesSnapshotEvent extends EventBase {
  type: 'MESSAGES_SNAPSHOT';
  messages: MessageSnapshot[];
}
export interface ActivitySnapshotEvent extends EventBase {
  type: 'ACTIVITY_SNAPSHOT';
  snapshot: unknown;
}
export interface ActivityDeltaEvent extends EventBase {
  type: 'ACTIVITY_DELTA';
  delta: JsonPatchOp[];
}

// ---- AG-UI reasoning (optional) -----------------------------------------------

export interface ReasoningStartEvent extends EventBase {
  type: 'REASONING_START';
  messageId: string;
}
export interface ReasoningContentEvent extends EventBase {
  type: 'REASONING_CONTENT';
  messageId: string;
  delta: string;
}
export interface ReasoningEndEvent extends EventBase {
  type: 'REASONING_END';
  messageId: string;
}

// ---- Subagents ------------------------------------------------------------------

export interface SubagentStartedEvent extends EventBase {
  type: 'SUBAGENT_STARTED';
  subagentId: string;
  name: string;
  parentId?: string;
  input?: unknown;
}
export interface SubagentFinishedEvent extends EventBase {
  type: 'SUBAGENT_FINISHED';
  subagentId: string;
  output?: unknown;
}
export interface SubagentErrorEvent extends EventBase {
  type: 'SUBAGENT_ERROR';
  subagentId: string;
  message: string;
}

// ---- Escape hatches -------------------------------------------------------------

export interface CustomEvent extends EventBase {
  type: 'CUSTOM';
  name: string;
  value: unknown;
}
export interface RawEvent extends EventBase {
  type: 'RAW';
  event: unknown;
  source?: string;
}

// ---- This library's own -----------------------------------------------------------

export interface ApprovalRequestedEvent extends EventBase {
  type: 'APPROVAL_REQUESTED';
  approvalId: string;
  toolCallId?: string;
  kind: ApprovalKind;
  title: string;
  payload?: unknown;
  options?: string[];
  expiresAt?: number;
}
export interface ApprovalResolvedEvent extends EventBase {
  type: 'APPROVAL_RESOLVED';
  approvalId: string;
  decision: ApprovalDecision;
  payload?: unknown;
  resolvedBy: ResolvedBy;
}
/** The resolution was successfully sent to the backend; remove it from the outbox. */
export interface ApprovalDeliveredEvent extends EventBase {
  type: 'APPROVAL_DELIVERED';
  approvalId: string;
}
export interface UsageEvent extends EventBase {
  type: 'USAGE';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}
export interface CheckpointEvent extends EventBase {
  type: 'CHECKPOINT';
  label: string;
  state?: unknown;
}
export interface StreamCursorEvent extends EventBase {
  type: 'STREAM_CURSOR';
  cursor: string;
}

export type SessionEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | ActivitySnapshotEvent
  | ActivityDeltaEvent
  | ReasoningStartEvent
  | ReasoningContentEvent
  | ReasoningEndEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentErrorEvent
  | CustomEvent
  | RawEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalDeliveredEvent
  | UsageEvent
  | CheckpointEvent
  | StreamCursorEvent;

export type SessionEventType = SessionEvent['type'];

/** An event as handed to `store.append()`: `seq` and `ts` are filled in by the store. */
export type EventInput<E extends SessionEvent = SessionEvent> = E extends SessionEvent
  ? Omit<E, 'seq' | 'ts'> & { seq?: number; ts?: number }
  : never;

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STEP_STARTED',
  'STEP_FINISHED',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  'ACTIVITY_SNAPSHOT',
  'ACTIVITY_DELTA',
  'REASONING_START',
  'REASONING_CONTENT',
  'REASONING_END',
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'SUBAGENT_ERROR',
  'CUSTOM',
  'RAW',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'APPROVAL_DELIVERED',
  'USAGE',
  'CHECKPOINT',
  'STREAM_CURSOR',
];

export function isSessionEventType(type: unknown): type is SessionEventType {
  return typeof type === 'string' && (SESSION_EVENT_TYPES as readonly string[]).includes(type);
}
