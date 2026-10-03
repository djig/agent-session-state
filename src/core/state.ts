import type {
  ApprovalDecision,
  ApprovalKind,
  MessagePart,
  ResolvedBy,
  Role,
} from './events';

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'error' | 'finished';

export interface RunState {
  runId: string;
  threadId?: string;
  parentRunId?: string;
  status: 'running' | 'finished' | 'error';
  startedAt: number;
  finishedAt?: number;
  error?: { message: string; code?: string };
  result?: unknown;
  /** Currently open step names, in start order. */
  steps: string[];
}

export interface Message {
  id: string;
  role: Role;
  /** Accumulated text content (all `text` parts joined). */
  content: string;
  parts: MessagePart[];
  /** Accumulated reasoning text, if any. */
  reasoning?: string;
  runId?: string;
  createdAt: number;
  /** true once TEXT_MESSAGE_END (or a snapshot) closed the message. */
  complete: boolean;
}

export type ToolCallStatus = 'streaming' | 'ready' | 'done' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw argument text as streamed; parsed into `args` on TOOL_CALL_END. */
  argsText: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status: ToolCallStatus;
  parentMessageId?: string;
  parentSubagentId?: string;
  runId?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface Approval {
  approvalId: string;
  toolCallId?: string;
  kind: ApprovalKind;
  title: string;
  payload?: unknown;
  options?: string[];
  expiresAt?: number;
  requestedAt: number;
  runId?: string;
  threadId?: string;
}

export interface Resolution {
  approvalId: string;
  decision: ApprovalDecision;
  payload?: unknown;
  resolvedBy: ResolvedBy;
  resolvedAt: number;
  runId?: string;
  threadId?: string;
}

export interface Subagent {
  id: string;
  name: string;
  parentId?: string;
  status: 'running' | 'finished' | 'error';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  input?: unknown;
  output?: unknown;
  runId?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  /** Number of USAGE events folded in. */
  calls: number;
}

export interface UsageState {
  totals: UsageTotals;
  byModel: Record<string, UsageTotals>;
}

export interface Cursor {
  /** seq of the last event reduced into this state. 0 means empty. */
  lastSeq: number;
  /** Transport-level cursor (e.g. last SSE `id:`), if the transport provided one. */
  streamCursor?: string;
  /** The most recently started run that has not finished. */
  runId?: string;
}

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  runs: Record<string, RunState>;
  messages: Message[];
  toolCalls: Record<string, ToolCall>;
  /** Oldest first. */
  pendingApprovals: Approval[];
  resolvedApprovals: Record<string, Resolution>;
  /** Resolutions not yet acknowledged by the backend (APPROVAL_DELIVERED). Oldest first. */
  outbox: Resolution[];
  subagents: Record<string, Subagent>;
  sharedState: unknown;
  activity: unknown;
  usage: UsageState;
  cursor: Cursor;
  lastEventAt?: number;
  lastError?: { message: string; code?: string; runId?: string };
  checkpoints: Array<{ label: string; seq: number; ts: number }>;
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, calls: 0 };
}

export function createEmptyState(sessionId: string): SessionState {
  return {
    sessionId,
    status: 'idle',
    runs: {},
    messages: [],
    toolCalls: {},
    pendingApprovals: [],
    resolvedApprovals: {},
    outbox: [],
    subagents: {},
    sharedState: undefined,
    activity: undefined,
    usage: { totals: emptyUsageTotals(), byModel: {} },
    cursor: { lastSeq: 0 },
    checkpoints: [],
  };
}

export interface SubagentNode extends Subagent {
  children: SubagentNode[];
}

/** Build a nested tree from the flat subagent record. Roots are subagents with no (known) parent. */
export function subagentTree(subagents: Record<string, Subagent>): SubagentNode[] {
  const nodes: Record<string, SubagentNode> = {};
  const list = Object.values(subagents).sort((a, b) => a.startedAt - b.startedAt);
  for (const s of list) nodes[s.id] = { ...s, children: [] };
  const roots: SubagentNode[] = [];
  for (const s of list) {
    const node = nodes[s.id]!;
    const parent = s.parentId ? nodes[s.parentId] : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Direct children of a subagent (or roots when `parentId` is undefined). */
export function children(
  subagents: Record<string, Subagent>,
  parentId: string | undefined,
): Subagent[] {
  return Object.values(subagents)
    .filter((s) => (parentId === undefined ? !s.parentId || !subagents[s.parentId] : s.parentId === parentId))
    .sort((a, b) => a.startedAt - b.startedAt);
}
